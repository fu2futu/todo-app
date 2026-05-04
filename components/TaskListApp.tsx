"use client";

import { type CSSProperties, FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import type { Task } from "@/types/task";

const LONG_PRESS_MS = 220;
const SWIPE_DELETE_THRESHOLD = 116;

type DragState = {
  id: string;
  pointerId: number;
  startY: number;
  offsetY: number;
  initialIndex: number;
  currentIndex: number;
};

type SwipeState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  startScrollTop: number;
};

const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

type InsertMode = "stack" | "queue";

function formatSupabaseError(prefix: string, error: { message?: string | null } | null) {
  const message = error?.message?.trim();
  return message ? `${prefix}: ${message}` : prefix;
}

function swapTaskWithSibling(tasks: Task[], activeId: string, direction: "up" | "down") {
  const currentIndex = tasks.findIndex((task) => task.id === activeId);

  if (currentIndex === -1) {
    return tasks;
  }

  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

  if (targetIndex < 0 || targetIndex >= tasks.length) {
    return tasks;
  }

  const next = [...tasks];
  const activeTask = next[currentIndex];
  next[currentIndex] = next[targetIndex];
  next[targetIndex] = activeTask;

  return next.map((task, index) => ({
    ...task,
    priority: index + 1
  }));
}

export function TaskListApp() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [insertMode, setInsertMode] = useState<InsertMode>("queue");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const swipeStateRef = useRef<SwipeState | null>(null);
  const swipeOffsetRef = useRef<Record<string, number>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [swipeOffsets, setSwipeOffsets] = useState<Record<string, number>>({});
  const [recentlyInsertedId, setRecentlyInsertedId] = useState<string | null>(null);
  const [composerExiting, setComposerExiting] = useState(false);
  const tasksRef = useRef<Task[]>([]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    const savedMode = window.localStorage.getItem("todo-insert-mode");
    if (savedMode === "stack" || savedMode === "queue") {
      setInsertMode(savedMode);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("todo-insert-mode", insertMode);
  }, [insertMode]);

  useEffect(() => {
    let active = true;

    async function loadTasks() {
      if (!supabase) {
        setError("Supabase の環境変数が未設定です。");
        setLoading(false);
        return;
      }

      const { data, error: fetchError } = await supabase
        .from("tasks")
        .select("id, title, priority, created_at, updated_at")
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });

      if (!active) {
        return;
      }

      if (fetchError) {
        setError(formatSupabaseError("タスクの読み込みに失敗しました", fetchError));
      } else {
        setTasks((data as Task[]) ?? []);
      }

      setLoading(false);
    }

    void loadTasks();

    return () => {
      active = false;
    };
  }, [supabase]);

  useEffect(() => {
    if (!recentlyInsertedId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRecentlyInsertedId(null);
    }, 700);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [recentlyInsertedId]);

  useEffect(() => {
    if (!composerExiting) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setComposerExiting(false);
    }, 380);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [composerExiting]);

  async function persistOrder(nextTasks: Task[]) {
    if (!supabase) {
      throw new Error("Supabase is unavailable.");
    }

    // UNIQUE制約による競合を避けるため、一時的に負の優先度を割り当てる
    for (let i = 0; i < nextTasks.length; i++) {
      const task = nextTasks[i];
      const { error } = await supabase
        .from("tasks")
        .update({
          priority: -(i + 1)  // 一時的に負の値
        })
        .eq("id", task.id);

      if (error) {
        throw error;
      }
    }

    // その後、正の優先度に更新
    for (let i = 0; i < nextTasks.length; i++) {
      const task = nextTasks[i];
      const { error } = await supabase
        .from("tasks")
        .update({
          priority: i + 1
        })
        .eq("id", task.id);

      if (error) {
        throw error;
      }
    }
  }

  async function handleAddTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitDraftTask();
  }

  async function submitDraftTask() {
    const title = draft.replace(/\s+/g, " ").trim().slice(0, 14);

    if (!title || saving) {
      return;
    }

    setSaving(true);
    setError(null);

    if (!supabase) {
      setError("Supabase の環境変数が未設定です。");
      setSaving(false);
      return;
    }

    const priorities = tasks.map((task) => task.priority);
    const minPriority = priorities.length > 0 ? Math.min(...priorities) : 0;
    const maxPriority = priorities.length > 0 ? Math.max(...priorities) : 0;
    const priority = insertMode === "stack" ? minPriority - 1 : maxPriority + 1;
    const { data, error: insertError } = await supabase
      .from("tasks")
      .insert({
        title,
        priority
      })
      .select("id, title, priority, created_at, updated_at")
      .single();

    if (insertError) {
      setError(formatSupabaseError("タスク追加に失敗しました", insertError));
      setSaving(false);
      return;
    }

    setComposerExiting(true);
    setTasks((current) =>
      insertMode === "stack" ? [data as Task, ...current] : [...current, data as Task]
    );
    setDraft("");
    setRecentlyInsertedId((data as Task).id);
    setMenuOpen(false);
    setSaving(false);
  }

  async function handleDeleteTask(taskId: string) {
    if (!supabase) {
      setError("Supabase の環境変数が未設定です。");
      return;
    }

    const previousTasks = tasks;
    const remaining = tasks
      .filter((task) => task.id !== taskId)
      .map((task, index) => ({ ...task, priority: index + 1 }));

    setTasks(remaining);
    setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));
    setSaving(true);
    setError(null);

    const deleteResult = await supabase.from("tasks").delete().eq("id", taskId);

    if (deleteResult.error) {
      setTasks(previousTasks);
      setError(formatSupabaseError("タスク削除に失敗しました", deleteResult.error));
      setSaving(false);
      return;
    }

    try {
      await persistOrder(remaining);
    } catch (persistError) {
      setTasks(previousTasks);
      setError(
        formatSupabaseError(
          "優先度の更新に失敗しました",
          persistError instanceof Error ? { message: persistError.message } : null
        )
      );
    } finally {
      setSaving(false);
    }
  }

  function clearGestureState() {
    if (dragTimerRef.current) {
      window.clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    dragStateRef.current = null;
    swipeStateRef.current = null;
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>, taskId: string) {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    swipeStateRef.current = {
      id: taskId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollTop: viewportRef.current?.scrollTop ?? 0
    };

    dragTimerRef.current = window.setTimeout(() => {
      const currentIndex = tasksRef.current.findIndex((task) => task.id === taskId);
      dragStateRef.current = {
        id: taskId,
        pointerId: event.pointerId,
        startY: event.clientY,
        offsetY: 0,
        initialIndex: currentIndex,
        currentIndex: currentIndex
      };
      setDraggingId(taskId);
      setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));
    }, LONG_PRESS_MS);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>, taskId: string) {
    const dragState = dragStateRef.current;
    const swipeState = swipeStateRef.current;

    if (dragState && dragState.id === taskId && dragState.pointerId === event.pointerId) {
      event.preventDefault();
      const offsetY = event.clientY - dragState.startY;
      
      // ドラッグされているアイテムのtransformを更新
      const activeRow = rowRefs.current[taskId];
      if (activeRow) {
        activeRow.style.transform = `translate3d(0, ${offsetY}px, 0)`;
      }

      // スクロール
      const viewport = viewportRef.current;
      if (viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        const edgeThreshold = 72;

        if (event.clientY < viewportRect.top + edgeThreshold) {
          viewport.scrollTop -= 12;
        } else if (event.clientY > viewportRect.bottom - edgeThreshold) {
          viewport.scrollTop += 12;
        }
      }

      // 入れ替わる相手を判定
      const orderedTasks = tasksRef.current;
      const activeIndex = orderedTasks.findIndex((task) => task.id === taskId);
      const activeRect = activeRow?.getBoundingClientRect();
      const rowHeight = activeRect?.height ?? 0;

      if (activeIndex === -1 || !activeRect || rowHeight === 0) {
        return;
      }

      // オフセット量から何個分移動したかを計算
      const movement = Math.round(offsetY / rowHeight);
      const newIndex = Math.max(0, Math.min(activeIndex + movement, orderedTasks.length - 1));

      // 新しいインデックスが前のインデックスと異なれば、中間のアイテムをtransformで移動
      if (newIndex !== dragState.currentIndex) {
        orderedTasks.forEach((task, index) => {
          if (task.id === taskId) {
            return;  // ドラッグ中のアイテムは処理しない
          }

          // 新しいインデックスと前のインデックスの範囲内なら移動させる
          const minIndex = Math.min(dragState.currentIndex, newIndex);
          const maxIndex = Math.max(dragState.currentIndex, newIndex);

          if (index >= minIndex && index <= maxIndex) {
            const row = rowRefs.current[task.id];
            if (row) {
              if (newIndex > dragState.currentIndex) {
                // 下に移動する場合、その範囲のアイテムを上に
                row.style.transform = `translate3d(0, ${-rowHeight}px, 0)`;
              } else {
                // 上に移動する場合、その範囲のアイテムを下に
                row.style.transform = `translate3d(0, ${rowHeight}px, 0)`;
              }
            }
          } else {
            // 範囲外のアイテムはリセット
            const row = rowRefs.current[task.id];
            if (row) {
              row.style.transform = "";
            }
          }
        });

        dragStateRef.current = {
          ...dragState,
          offsetY,
          currentIndex: newIndex
        };
      }

      return;
    }

    if (!swipeState || swipeState.id !== taskId || swipeState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - swipeState.startX;
    const deltaY = event.clientY - swipeState.startY;
    const absDeltaY = Math.abs(deltaY);

    if (absDeltaY > 12 && absDeltaY > Math.abs(deltaX)) {
      if (dragTimerRef.current) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }

      if (viewportRef.current) {
        viewportRef.current.scrollTop = swipeState.startScrollTop - deltaY;
      }

      return;
    }

    if (deltaX > 0 && absDeltaY < 28) {
      if (dragTimerRef.current) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }

      const offset = Math.min(deltaX, 132);
      swipeOffsetRef.current[taskId] = offset;
      setSwipeOffsets((current) => ({
        ...current,
        [taskId]: offset
      }));
    }
  }

  async function handlePointerEnd(event: PointerEvent<HTMLDivElement>, taskId: string) {
    const row = rowRefs.current[taskId];
    const dragState = dragStateRef.current;
    const swipeOffset = swipeOffsetRef.current[taskId] ?? 0;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragState && dragState.id === taskId && dragState.pointerId === event.pointerId) {
      setDraggingId(null);
      clearGestureState();

      // 全アイテムのtransformをリセット
      tasksRef.current.forEach((task) => {
        const taskRow = rowRefs.current[task.id];
        if (taskRow) {
          taskRow.style.transform = "";
        }
      });

      // インデックスが変わっていれば tasks を更新
      if (dragState.currentIndex !== dragState.initialIndex) {
        const currentTasks = tasksRef.current;
        const draggedTask = currentTasks[dragState.initialIndex];
        
        // 初期位置から現在位置への順序変更を反映
        const newTasks = currentTasks.filter((_, index) => index !== dragState.initialIndex);
        newTasks.splice(dragState.currentIndex, 0, draggedTask);
        
        // 優先度を再計算
        const finalTasks = newTasks.map((task, index) => ({
          ...task,
          priority: index + 1
        }));

        setTasks(finalTasks);
        tasksRef.current = finalTasks;

        try {
          setSaving(true);
          await persistOrder(finalTasks);
        } catch (persistError) {
          setError(
            formatSupabaseError(
              "並べ替えの保存に失敗しました",
              persistError instanceof Error ? { message: persistError.message } : null
            )
          );
          // ロールバック
          setTasks(currentTasks);
          tasksRef.current = currentTasks;
        } finally {
          setSaving(false);
        }
      }

      swipeOffsetRef.current[taskId] = 0;
      setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));
      return;
    }

    if (row) {
      row.style.transform = "";
    }

    clearGestureState();

    if (swipeOffset >= SWIPE_DELETE_THRESHOLD) {
      swipeOffsetRef.current[taskId] = 0;
      await handleDeleteTask(taskId);
      return;
    }

    swipeOffsetRef.current[taskId] = 0;
    setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));
  }

  return (
    <main className="pageShell">
      <div className="pageFrame">
        <section className="photoBoard">
          <header className="pageHeader">
            <h1 className="pageTitle">やること木箱</h1>
            <p className="pageSubtitle">14文字以内。長押しで上下入れ替え、右スワイプで削除。</p>
          </header>

          <section
            ref={viewportRef}
            className={`taskViewport ${tasks.length <= 5 ? "isBottomStack" : "isTopStack"}`}
            aria-live="polite"
          >
            <div className={`taskStack ${tasks.length <= 5 ? "isBottomStack" : "isTopStack"}`}>
              {tasks.map((task, index) => (
                <div
                  key={task.id}
                  className={`taskRow${recentlyInsertedId === task.id ? " isInserted" : ""}${
                    draggingId === task.id ? " isDraggingRow" : ""
                  }`}
                  ref={(element) => {
                    rowRefs.current[task.id] = element;
                  }}
                  style={
                    {
                      "--stack-z": tasks.length - index
                    } as CSSProperties
                  }
                >
                  <div className="deleteLayer">削除</div>
                  <div
                    className="taskCardShell"
                    style={{
                      transform: `translateX(${swipeOffsets[task.id] ?? 0}px)`
                    }}
                  >
                    <div
                      className={`woodBoxCard${draggingId === task.id ? " isDragging" : ""}`}
                      aria-hidden="true"
                    />
                    <div
                      className="taskHitArea"
                      onPointerDown={(event) => handlePointerDown(event, task.id)}
                      onPointerMove={(event) => handlePointerMove(event, task.id)}
                      onPointerUp={(event) => void handlePointerEnd(event, task.id)}
                      onPointerCancel={(event) => void handlePointerEnd(event, task.id)}
                    />
                    <div className="woodBoxFace woodBoxFaceDisplay">
                      <div className="woodBoxTitlePlate woodBoxTitlePlateDisplay">
                        <div className="taskText">{task.title}</div>
                      </div>
                      <span className="taskMeta taskMetaPlate taskMetaPlateDisplay">
                        {timeFormatter.format(new Date(task.updated_at))}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <form className="composerForm" onSubmit={handleAddTask}>
            <div className="taskRow taskRowComposer">
              <div
                className={`taskCardShell taskCardShellComposer${
                  composerExiting ? " isExiting" : ""
                }`}
              >
                <div className="woodBoxCard woodBoxCardComposer" aria-hidden="true" />
                <div className="woodBoxFace woodBoxFaceComposer">
                  <div className="woodBoxTitlePlate woodBoxTitlePlateComposer">
                    <textarea
                      className="taskInput"
                      enterKeyHint="done"
                      rows={2}
                      placeholder="やることを追加"
                      value={draft}
                      maxLength={14}
                      onChange={(event) =>
                        setDraft(event.target.value.replace(/\r?\n/g, " ").slice(0, 14))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitDraftTask();
                        }
                      }}
                    />
                  </div>
                  <span className="taskMeta taskMetaPlate taskMetaPlateComposer">return で追加</span>
                </div>
              </div>
            </div>
          </form>
        </section>

        {!loading && tasks.length === 0 ? (
          <div className="emptyState">まだタスクがありません。上の箱から追加してください。</div>
        ) : null}

        {error ? <div className="errorState">{error}</div> : null}
        <div className="statusRow">{loading ? "読み込み中..." : saving ? "保存中..." : "同期済み"}</div>
        <div className="modeDock">
          {menuOpen ? (
            <div className="modeMenu">
              <button
                type="button"
                className={`modeMenuItem${insertMode === "stack" ? " isActive" : ""}`}
                onClick={() => {
                  setInsertMode("stack");
                  setMenuOpen(false);
                }}
              >
                スタック
              </button>
              <button
                type="button"
                className={`modeMenuItem${insertMode === "queue" ? " isActive" : ""}`}
                onClick={() => {
                  setInsertMode("queue");
                  setMenuOpen(false);
                }}
              >
                キュー
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="modeButton"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {insertMode === "stack" ? "S" : "Q"}
          </button>
        </div>
      </div>
    </main>
  );
}

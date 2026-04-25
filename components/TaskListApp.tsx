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
};

type SwipeState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
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

function reorderTasks(tasks: Task[], activeId: string, overId: string) {
  const currentIndex = tasks.findIndex((task) => task.id === activeId);
  const targetIndex = tasks.findIndex((task) => task.id === overId);

  if (currentIndex === -1 || targetIndex === -1 || currentIndex === targetIndex) {
    return tasks;
  }

  const next = [...tasks];
  const [moved] = next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, moved);

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
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const swipeStateRef = useRef<SwipeState | null>(null);
  const swipeOffsetRef = useRef<Record<string, number>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [swipeOffsets, setSwipeOffsets] = useState<Record<string, number>>({});
  const [recentlyInsertedId, setRecentlyInsertedId] = useState<string | null>(null);
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

  async function persistOrder(nextTasks: Task[]) {
    if (!supabase) {
      throw new Error("Supabase is unavailable.");
    }

    const updates = nextTasks.map((task, index) =>
      supabase
        .from("tasks")
        .update({
          priority: index + 1
        })
        .eq("id", task.id)
    );

    const results = await Promise.all(updates);
    const failed = results.find((result) => result.error);

    if (failed?.error) {
      throw failed.error;
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
      startY: event.clientY
    };

    dragTimerRef.current = window.setTimeout(() => {
      dragStateRef.current = {
        id: taskId,
        pointerId: event.pointerId,
        startY: event.clientY,
        offsetY: 0
      };
      setDraggingId(taskId);
      setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));
    }, LONG_PRESS_MS);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>, taskId: string) {
    const dragState = dragStateRef.current;
    const swipeState = swipeStateRef.current;

    if (dragState && dragState.id === taskId && dragState.pointerId === event.pointerId) {
      const offsetY = event.clientY - dragState.startY;
      dragStateRef.current = {
        ...dragState,
        offsetY
      };

      const activeRow = rowRefs.current[taskId];
      if (activeRow) {
        activeRow.style.transform = `translate3d(0, ${offsetY}px, 0)`;
      }

      const hoveredTask = tasks.find((task) => {
        if (task.id === taskId) {
          return false;
        }

        const element = rowRefs.current[task.id];
        if (!element) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        return event.clientY >= rect.top && event.clientY <= rect.bottom;
      });

      if (hoveredTask) {
        setTasks((current) => reorderTasks(current, taskId, hoveredTask.id));
      }

      return;
    }

    if (!swipeState || swipeState.id !== taskId || swipeState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - swipeState.startX;
    const deltaY = Math.abs(event.clientY - swipeState.startY);

    if (deltaY > 18 && Math.abs(deltaX) < 18) {
      if (dragTimerRef.current) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
      return;
    }

    if (deltaX > 0 && deltaY < 28) {
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

    if (row) {
      row.style.transform = "";
    }

    if (dragState && dragState.id === taskId && dragState.pointerId === event.pointerId) {
      setDraggingId(null);
      clearGestureState();
      swipeOffsetRef.current[taskId] = 0;
      setSwipeOffsets((current) => ({ ...current, [taskId]: 0 }));

      try {
        setSaving(true);
        await persistOrder(tasksRef.current);
      } catch (persistError) {
        setError(
          formatSupabaseError(
            "並べ替えの保存に失敗しました",
            persistError instanceof Error ? { message: persistError.message } : null
          )
        );
      } finally {
        setSaving(false);
      }

      return;
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
            <p className="pageSubtitle">14文字以内で入力してください。詳細は箱の中に</p>
          </header>

          <section
            className={`taskViewport ${tasks.length <= 5 ? "isBottomStack" : "isTopStack"}`}
            aria-live="polite"
          >
            <div className={`taskStack ${tasks.length <= 5 ? "isBottomStack" : "isTopStack"}`}>
              {tasks.map((task, index) => (
                <div
                  key={task.id}
                  className={`taskRow${recentlyInsertedId === task.id ? " isInserted" : ""}`}
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
              <div className="taskCardShell taskCardShellComposer">
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

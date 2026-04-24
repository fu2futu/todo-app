"use client";

import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const tasksRef = useRef<Task[]>([]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

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

    loadTasks();

    return () => {
      active = false;
    };
  }, [supabase]);

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
    const title = draft.trim();

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

    const priority = tasks.length + 1;
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

    setTasks((current) => [...current, data as Task]);
    setDraft("");
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
        activeRow.style.transform = `translate3d(0, ${offsetY}px, 0) scale(1.01)`;
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
        <header className="pageHeader">
          <h1 className="pageTitle">やることリスト</h1>
          <p className="pageSubtitle">長押しで並べ替え。右スワイプで削除。</p>
        </header>

        <section className="taskStack" aria-live="polite">
          <form onSubmit={handleAddTask}>
            <div className="taskRow">
              <div className="taskCard">
                <div className="taskGrip" aria-hidden="true">
                  <div className="taskGripDots" />
                </div>
                <div className="taskBody">
                  <input
                    className="taskInput"
                    type="text"
                    inputMode="text"
                    enterKeyHint="done"
                    placeholder="新しいタスクを追加"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <span className="taskMeta">入力して return で追加</span>
                </div>
              </div>
            </div>
          </form>

          {tasks.map((task) => (
            <div
              key={task.id}
              className="taskRow"
              ref={(element) => {
                rowRefs.current[task.id] = element;
              }}
            >
              <div className="deleteLayer">削除</div>
              <div
                className={`taskCard${draggingId === task.id ? " isDragging" : ""}`}
                onPointerDown={(event) => handlePointerDown(event, task.id)}
                onPointerMove={(event) => handlePointerMove(event, task.id)}
                onPointerUp={(event) => void handlePointerEnd(event, task.id)}
                onPointerCancel={(event) => void handlePointerEnd(event, task.id)}
                style={{
                  transform:
                    draggingId === task.id
                      ? undefined
                      : `translateX(${swipeOffsets[task.id] ?? 0}px)`
                }}
              >
                <div className="taskGrip" aria-hidden="true">
                  <div className="taskGripDots" />
                </div>
                <div className="taskBody">
                  <div className="taskText">{task.title}</div>
                  <span className="taskMeta">{timeFormatter.format(new Date(task.updated_at))}</span>
                </div>
              </div>
            </div>
          ))}
        </section>

        {!loading && tasks.length === 0 ? (
          <div className="emptyState">まだタスクがありません。上の欄から追加してください。</div>
        ) : null}

        {error ? <div className="errorState">{error}</div> : null}
        <div className="statusRow">{loading ? "読み込み中..." : saving ? "保存中..." : "同期済み"}</div>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import axios from "axios";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { LoginButton } from "@/components/LoginButton";
import { useAuth } from "@/context/AuthContext";

type SessionDoc = {
  id: string;
  user_id: string;
  kind: string;
  created_at: string;
  payload: {
    role?: string;
    score?: number;
    [key: string]: unknown;
  };
};

type ChartPoint = {
  index: number;
  score: number;
  label: string;
};

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL?.trim() || "http://localhost:8000";

export default function DashboardPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<SessionDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSessions = async () => {
      if (!user) {
        setSessions([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const token = await user.getIdToken();
        const res = await axios.get<SessionDoc[]>(
          `${BACKEND_URL}/sessions/${user.uid}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        setSessions(res.data || []);
      } catch (e: any) {
        const msg =
          e?.response?.data?.detail ||
          e?.message ||
          "Failed to fetch sessions. Is the backend running?";
        setError(String(msg));
      } finally {
        setLoading(false);
      }
    };

    fetchSessions();
  }, [user]);

  const evalSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.kind === "evaluate_answer" &&
          typeof s.payload?.score === "number" &&
          !Number.isNaN(s.payload.score),
      ),
    [sessions],
  );

  const stats = useMemo(() => {
    if (!evalSessions.length) {
      return { count: 0, avgScore: 0 };
    }
    const total = evalSessions.reduce(
      (sum, s) => sum + (Number(s.payload.score) || 0),
      0,
    );
    const avg = total / evalSessions.length;
    return {
      count: evalSessions.length,
      avgScore: Math.round(avg * 10) / 10,
    };
  }, [evalSessions]);

  const chartData: ChartPoint[] = useMemo(() => {
    const sorted = [...evalSessions].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return sorted.map((s, idx) => ({
      index: idx + 1,
      score: Number(s.payload.score) || 0,
      label: new Date(s.created_at).toLocaleDateString(),
    }));
  }, [evalSessions]);

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Interview Dashboard
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Track your progress and revisit past interview sessions.
            </p>
          </div>
          <LoginButton />
        </header>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <div className="flex-1 rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Total sessions
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {stats.count.toLocaleString()}
              </div>
            </div>
            <div className="flex-1 rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Average score
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {stats.avgScore.toFixed(1)}
                <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                  {" "}
                  / 10
                </span>
              </div>
            </div>
          </div>

          <Link
            href="/interview"
            className="inline-flex items-center justify-center rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Start New Interview
          </Link>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Score over time</h2>
            {loading ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Loading…
              </span>
            ) : null}
          </div>

          {chartData.length ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: -20, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d4d4d8" />
                  <XAxis
                    dataKey="index"
                    tick={{ fontSize: 11, fill: "#71717a" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e4e4e7" }}
                  />
                  <YAxis
                    domain={[0, 10]}
                    tick={{ fontSize: 11, fill: "#71717a" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e4e4e7" }}
                  />
                  <Tooltip
                    formatter={(value) => [`${value ?? 0}/10`, "Score"]}
                   labelFormatter={(label, payload) =>
                      payload?.[0]?.payload?.label || `Session ${label}`
                    }
                    contentStyle={{
                      borderRadius: 12,
                      borderColor: "#e4e4e7",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="score"
                    stroke="#18181b"
                    strokeWidth={2}
                    dot={{ r: 4, strokeWidth: 1.5, fill: "#fff" }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              {user
                ? "No scored sessions yet. Start an interview to see your progress."
                : "Sign in and complete an interview to see your progress here."}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Past sessions</h2>

          {!evalSessions.length && !loading ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-5 py-6 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
              No sessions with scores yet. After you answer questions on the{" "}
              <Link
                href="/interview"
                className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100"
              >
                interview page
              </Link>
              , they will appear here.
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {evalSessions.map((s) => {
              const date = new Date(s.created_at);
              const role = s.payload.role ?? "Unknown role";
              const score = Number(s.payload.score) || 0;

              return (
                <div
                  key={s.id}
                  className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{role}</div>
                      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {date.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-full bg-zinc-900 px-3 py-1 text-sm font-semibold text-white dark:bg-white dark:text-zinc-950">
                      {score.toFixed(1)}/10
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}


"use client";

import { useCallback, useRef, useState } from "react";
import axios from "axios";
import { useDropzone } from "react-dropzone";

import { LoginButton } from "@/components/LoginButton";
import { useAuth } from "@/context/AuthContext";

type ChatMessage = {
  type: "interviewer" | "candidate";
  text: string;
  feedback?: string;
};

type ConversationTurn = { question: string; answer: string };

type FinalFeedback = {
  score: number;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
};

const ROLES = ["SDE", "Data Analyst", "ML Engineer", "Product Manager"] as const;

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL?.trim() || "http://127.0.0.1:8000";

const FIRST_MESSAGE =
  "Hello! I'll be your interviewer today. Let's start - Tell me about yourself.";

export default function InterviewPage() {
  const { user } = useAuth();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [role, setRole] = useState<(typeof ROLES)[number]>("SDE");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeSkills, setResumeSkills] = useState<string[]>([]);
  const [resumeStatus, setResumeStatus] = useState<
    "idle" | "uploading" | "parsed" | "error"
  >("idle");
  const [resumeError, setResumeError] = useState<string | null>(null);

  const [interviewPhase, setInterviewPhase] = useState<
    "idle" | "active" | "complete"
  >("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationHistory, setConversationHistory] = useState<
    ConversationTurn[]
  >([]);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [nextSendEndsInterview, setNextSendEndsInterview] = useState(false);
  const [finalFeedback, setFinalFeedback] = useState<FinalFeedback | null>(
    null,
  );

  const [startStatus, setStartStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [sendStatus, setSendStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [endStatus, setEndStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [apiError, setApiError] = useState<string | null>(null);

  const authHeader = useCallback(async () => {
    if (!user) return {};
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  }, [user]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;

      setResumeFile(file);
      setResumeSkills([]);
      setResumeStatus("uploading");
      setResumeError(null);
      setApiError(null);

      try {
        if (!user) {
          setResumeStatus("error");
          setResumeError("Please sign in first.");
          return;
        }

        const form = new FormData();
        form.append("file", file);

        const res = await axios.post<string[]>(
          `${BACKEND_URL}/parse-resume`,
          form,
          {
            headers: {
              ...(await authHeader()),
              "Content-Type": "multipart/form-data",
            },
          },
        );

        setResumeSkills(Array.isArray(res.data) ? res.data : []);
        setResumeStatus("parsed");
      } catch (e: unknown) {
        const err = e as { response?: { data?: { detail?: string } }; message?: string };
        const msg =
          err?.response?.data?.detail ||
          err?.message ||
          "Failed to parse resume. Is the backend running?";
        setResumeStatus("error");
        setResumeError(String(msg));
      }
    },
    [authHeader, user],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: { "application/pdf": [".pdf"] },
    disabled: resumeStatus === "uploading",
  });

  const startInterview = useCallback(async () => {
    setStartStatus("loading");
    setApiError(null);
    setMessages([{ type: "interviewer", text: FIRST_MESSAGE }]);
    setConversationHistory([]);
    setCurrentAnswer("");
    setNextSendEndsInterview(false);
    setFinalFeedback(null);
    setInterviewPhase("active");

    try {
      if (!user) {
        setStartStatus("error");
        setApiError("Please sign in first.");
        setInterviewPhase("idle");
        return;
      }

      await axios.post(
        `${BACKEND_URL}/start-interview`,
        { role, skills: resumeSkills },
        { headers: await authHeader() },
      );

      setStartStatus("idle");
      scrollToBottom();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        "Failed to start interview.";
      setStartStatus("error");
      setApiError(String(msg));
      setInterviewPhase("idle");
      setMessages([]);
    }
  }, [authHeader, resumeSkills, role, user, scrollToBottom]);

  const exchangeCount = conversationHistory.length;
  const currentQuestion =
    messages.filter((m) => m.type === "interviewer").pop()?.text ?? "";

  const sendAnswer = useCallback(async () => {
    const answer = currentAnswer.trim();
    if (!answer || sendStatus === "loading") return;
    if (!user) {
      setApiError("Please sign in first.");
      return;
    }

    setSendStatus("loading");
    setApiError(null);

    const newHistory: ConversationTurn[] = [
      ...conversationHistory,
      { question: currentQuestion, answer },
    ];

    setMessages((prev) => [...prev, { type: "candidate", text: answer }]);
    setCurrentAnswer("");
    scrollToBottom();

    if (nextSendEndsInterview) {
      setEndStatus("loading");
      try {
        const res = await axios.post<FinalFeedback>(
          `${BACKEND_URL}/end-interview`,
          { conversation_history: newHistory },
          { headers: await authHeader() },
        );
        setFinalFeedback(res.data);
        setInterviewPhase("complete");
        setConversationHistory(newHistory);
      } catch (e: unknown) {
        const err = e as { response?: { data?: { detail?: string } }; message?: string };
        setApiError(
          err?.response?.data?.detail || err?.message || "Failed to get feedback.",
        );
        setEndStatus("error");
      }
      setSendStatus("idle");
      setEndStatus("idle");
      return;
    }

    try {
      const res = await axios.post<{
        feedback: string;
        next_question: string;
        is_complete: boolean;
      }>(`${BACKEND_URL}/next-question`, {
        previous_question: currentQuestion,
        candidate_answer: answer,
        role,
        skills: resumeSkills,
        conversation_history: conversationHistory,
      });

      setConversationHistory(newHistory);
      setNextSendEndsInterview(res.data.is_complete);

      setMessages((prev) => {
        const updated = [...prev];
        const lastInterviewerIdx = updated
          .map((m, i) => (m.type === "interviewer" ? i : -1))
          .filter((i) => i >= 0)
          .pop();
        if (lastInterviewerIdx !== undefined) {
          updated[lastInterviewerIdx] = {
            ...updated[lastInterviewerIdx],
            feedback: res.data.feedback,
          };
        }
        return [
          ...updated,
          {
            type: "interviewer",
            text: res.data.next_question,
          },
        ];
      });

      scrollToBottom();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setApiError(
        err?.response?.data?.detail ||
          err?.message ||
          "Failed to get next question.",
      );
      setSendStatus("error");
      setMessages((prev) => prev.slice(0, -1));
      setCurrentAnswer(answer);
    }
    setSendStatus("idle");
  }, [
    currentAnswer,
    currentQuestion,
    conversationHistory,
    nextSendEndsInterview,
    role,
    resumeSkills,
    user,
    authHeader,
    scrollToBottom,
    sendStatus,
  ]);

  const endInterviewEarly = useCallback(async () => {
    if (conversationHistory.length === 0) {
      setInterviewPhase("idle");
      setMessages([]);
      return;
    }
    setEndStatus("loading");
    setApiError(null);
    try {
      const res = await axios.post<FinalFeedback>(
        `${BACKEND_URL}/end-interview`,
        { conversation_history: conversationHistory },
        { headers: await authHeader() },
      );
      setFinalFeedback(res.data);
      setInterviewPhase("complete");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setApiError(
        err?.response?.data?.detail || err?.message || "Failed to end interview.",
      );
      setEndStatus("error");
    }
    setEndStatus("idle");
  }, [conversationHistory, authHeader]);

  const canStart =
    Boolean(user) &&
    startStatus !== "loading" &&
    interviewPhase === "idle";

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Interview Practice
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Conversational mock interview. Upload resume, then start.
            </p>
          </div>
          <LoginButton />
        </header>

        {apiError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
            {apiError}
          </div>
        ) : null}

        {interviewPhase === "idle" ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Role
                </label>
                <select
                  value={role}
                  onChange={(e) =>
                    setRole(e.target.value as (typeof ROLES)[number])
                  }
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:ring-zinc-600"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Resume (PDF)
                </label>
                <div
                  {...getRootProps()}
                  className={
                    "flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-4 text-center text-sm transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800/50 dark:hover:bg-zinc-800 " +
                    (isDragActive ? "ring-2 ring-zinc-400 dark:ring-zinc-500 " : "") +
                    (resumeStatus === "uploading" ? "cursor-not-allowed opacity-70" : "")
                  }
                >
                  <input {...getInputProps()} />
                  <div className="font-medium">
                    {resumeStatus === "uploading"
                      ? "Parsing…"
                      : resumeFile
                        ? resumeFile.name
                        : "Drop PDF or click"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    We use skills to tailor questions.
                  </div>
                </div>
                {resumeError ? (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {resumeError}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {resumeSkills.length > 0 ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {resumeSkills.length} skills extracted
                </span>
              ) : (
                <span className="text-sm text-zinc-500 dark:text-zinc-500">
                  Optional: upload resume for tailored questions
                </span>
              )}
              <button
                type="button"
                onClick={startInterview}
                disabled={!canStart}
                className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {startStatus === "loading" ? "Starting…" : "Start Interview"}
              </button>
            </div>

            {resumeSkills.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {resumeSkills.slice(0, 20).map((s) => (
                  <span
                    key={s}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {interviewPhase === "active" && !finalFeedback ? (
          <>
            <div className="flex items-center justify-between text-sm text-zinc-600 dark:text-zinc-400">
              <span>
                Question {exchangeCount + 1} of ~8–10
              </span>
              <button
                type="button"
                onClick={endInterviewEarly}
                disabled={endStatus === "loading"}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                End Interview
              </button>
            </div>

            <div className="flex flex-col rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex max-h-[50vh] min-h-[280px] flex-1 flex-col overflow-y-auto p-4">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={
                      m.type === "interviewer"
                        ? "mb-4 flex justify-start"
                        : "mb-4 flex justify-end"
                    }
                  >
                    <div
                      className={
                        "max-w-[85%] rounded-2xl px-4 py-3 " +
                        (m.type === "interviewer"
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                          : "bg-blue-600 text-white dark:bg-blue-700")
                      }
                    >
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">
                        {m.text}
                      </p>
                      {m.feedback ? (
                        <p className="mt-2 border-t border-zinc-200 pt-2 text-xs italic text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
                          {m.feedback}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-zinc-200 p-4 dark:border-zinc-700">
                <div className="flex gap-2">
                  <textarea
                    value={currentAnswer}
                    onChange={(e) => setCurrentAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendAnswer();
                      }
                    }}
                    placeholder="Type your answer…"
                    rows={2}
                    className="min-w-0 flex-1 resize-none rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:ring-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={sendAnswer}
                    disabled={!currentAnswer.trim() || sendStatus === "loading"}
                    className="self-end rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {sendStatus === "loading" ? "…" : "Send"}
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {interviewPhase === "complete" && finalFeedback ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              Interview complete
            </h2>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
                {finalFeedback.score}
              </span>
              <span className="text-zinc-600 dark:text-zinc-400">/ 10</span>
            </div>

            <div className="mt-6 grid gap-6 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  Strengths
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                  {finalFeedback.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                  Areas to improve
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                  {finalFeedback.weaknesses.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Specific tips
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                {finalFeedback.improvements.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>

            <button
              type="button"
              onClick={() => {
                setInterviewPhase("idle");
                setMessages([]);
                setConversationHistory([]);
                setFinalFeedback(null);
                setNextSendEndsInterview(false);
              }}
              className="mt-6 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            >
              Practice again
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}

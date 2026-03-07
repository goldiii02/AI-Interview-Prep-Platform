"use client";

import { useMemo } from "react";

import { useAuth } from "@/context/AuthContext";

function initials(name?: string | null) {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase()).join("") || "U";
}

export function LoginButton() {
  const { user, loading, signInWithGoogle, signOutUser } = useAuth();

  const displayName = user?.displayName || user?.email || "Signed in";
  const initialsText = useMemo(() => initials(user?.displayName || user?.email), [user]);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-3 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        <div className="h-8 w-8 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      </div>
    );
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={signInWithGoogle}
        className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-xs font-bold dark:bg-zinc-950/10">
          G
        </span>
        Continue with Google
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-3 rounded-full border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        {user.photoURL ? (
          // using <img> avoids Next remote image config
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.photoURL}
            alt={displayName}
            className="h-8 w-8 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {initialsText}
          </div>
        )}
        <div className="min-w-0">
          <div className="max-w-[14rem] truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {displayName}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={signOutUser}
        className="inline-flex items-center justify-center rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
      >
        Sign out
      </button>
    </div>
  );
}


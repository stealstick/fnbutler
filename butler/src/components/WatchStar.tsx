"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WatchStar({
  corpCode,
  initialWatched,
  loggedIn,
}: {
  corpCode: string;
  initialWatched: boolean;
  loggedIn: boolean;
}) {
  const [watched, setWatched] = useState(initialWatched);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function toggle() {
    if (!loggedIn) {
      router.push("/login");
      return;
    }
    setBusy(true);
    if (watched) {
      await fetch(`/api/watchlist?corpCode=${corpCode}`, { method: "DELETE" });
      setWatched(false);
    } else {
      await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ corpCode }),
      });
      setWatched(true);
    }
    setBusy(false);
  }

  return (
    <button
      className={"btn" + (watched ? "" : " ghost")}
      onClick={toggle}
      disabled={busy}
      title={loggedIn ? "관심목록 토글" : "로그인 후 사용"}
    >
      {watched ? "★ 관심" : "☆ 관심추가"}
    </button>
  );
}

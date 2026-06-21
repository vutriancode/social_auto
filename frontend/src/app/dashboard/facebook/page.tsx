"use client";

import { useState, useEffect, useRef } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8099";

function getToken() {
  return typeof window !== "undefined" ? sessionStorage.getItem("campaign_token") : null;
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface FbPage {
  page_id: string;
  name: string;
  access_token: string;
  picture?: string;
  added_at?: string;
}

interface ScheduledJob {
  id: string;
  type: string;
  description: string;
  page_name: string;
  scheduled_time: string;
  status: string;
  result: string;
  created_at: string;
}

interface PostHistory {
  id: string;
  page_name: string;
  message: string;
  post_id: string;
  post_url: string;
  image_count: number;
  posted_at: string;
  was_scheduled: boolean;
}

// ── Tab navigation ────────────────────────────────────────────────────────────

type Tab = "pages" | "post" | "schedule" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "pages", label: "Quản lý Pages" },
  { id: "post", label: "Đăng bài" },
  { id: "schedule", label: "Lịch hẹn" },
  { id: "history", label: "Lịch sử" },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function FacebookPage() {
  const [tab, setTab] = useState<Tab>("pages");
  const [savedPages, setSavedPages] = useState<FbPage[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [history, setHistory] = useState<PostHistory[]>([]);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState<"ok" | "err">("ok");

  function flash(text: string, type: "ok" | "err" = "ok") {
    setMsg(text);
    setMsgType(type);
    setTimeout(() => setMsg(""), 5000);
  }

  async function loadSavedPages() {
    const r = await fetch(`${API}/api/facebook/saved-pages`, { headers: authHeaders() });
    const d = await r.json();
    if (r.ok) setSavedPages(d.pages || []);
  }

  async function loadSchedules() {
    const r = await fetch(`${API}/api/facebook/schedules`, { headers: authHeaders() });
    const d = await r.json();
    if (r.ok) setScheduledJobs(d.jobs || []);
  }

  async function loadHistory() {
    const r = await fetch(`${API}/api/facebook/history`, { headers: authHeaders() });
    const d = await r.json();
    if (r.ok) setHistory(d.history || []);
  }

  useEffect(() => {
    loadSavedPages();
  }, []);

  useEffect(() => {
    if (tab === "schedule") loadSchedules();
    if (tab === "history") loadHistory();
  }, [tab]);

  async function deletePage(pageId: string) {
    await fetch(`${API}/api/facebook/saved-pages/${pageId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    loadSavedPages();
  }

  async function cancelJob(jobId: string) {
    await fetch(`${API}/api/facebook/schedule/${jobId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    loadSchedules();
  }

  return (
    <div className="space-y-6">
      {/* Flash message */}
      {msg && (
        <div
          className={`p-3 rounded-lg text-sm font-semibold ${
            msgType === "ok"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {msg}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-xs font-bold rounded-t-lg transition-colors ${
              tab === t.id
                ? "bg-blue-600 text-white"
                : "text-slate-500 hover:text-slate-700 hover:bg-gray-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "pages" && (
        <PagesTab pages={savedPages} onRefresh={loadSavedPages} onDelete={deletePage} flash={flash} />
      )}
      {tab === "post" && (
        <PostTab pages={savedPages} flash={flash} onHistoryRefresh={loadHistory} />
      )}
      {tab === "schedule" && (
        <ScheduleTab
          pages={savedPages}
          jobs={scheduledJobs}
          flash={flash}
          onRefresh={loadSchedules}
          onCancel={cancelJob}
        />
      )}
      {tab === "history" && <HistoryTab history={history} onRefresh={loadHistory} />}
    </div>
  );
}

// ── Pages tab ─────────────────────────────────────────────────────────────────

function PagesTab({
  pages,
  onRefresh,
  onDelete,
  flash,
}: {
  pages: FbPage[];
  onRefresh: () => void;
  onDelete: (id: string) => void;
  flash: (m: string, t?: "ok" | "err") => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [token, setToken] = useState("");
  const [fetched, setFetched] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadPages() {
    setLoading(true);
    const r = await fetch(`${API}/api/facebook/pages`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    setLoading(false);
    if (!r.ok) return flash(d.detail || "Lỗi tải pages", "err");
    setFetched(d.pages || []);
  }

  async function savePage(p: any) {
    const r = await fetch(`${API}/api/facebook/saved-pages`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        page_id: p.id,
        name: p.name,
        access_token: p.access_token,
        picture: p.picture || "",
      }),
    });
    if (r.ok) {
      flash(`Đã lưu page "${p.name}"`);
      onRefresh();
    } else {
      const d = await r.json();
      flash(d.detail || "Lỗi lưu page", "err");
    }
  }

  const savedIds = new Set(pages.map((p) => p.page_id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-800 text-sm">Pages đã lưu ({pages.length})</h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700"
        >
          + Thêm trang
        </button>
      </div>

      {showAdd && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="User Access Token từ Facebook..."
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={loadPages}
              disabled={loading || !token}
              className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Đang tải..." : "Tải Pages"}
            </button>
          </div>

          {fetched.length > 0 && (
            <div className="space-y-2">
              {fetched.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-3"
                >
                  <div className="flex items-center gap-3">
                    {p.picture && (
                      <img src={p.picture} alt={p.name} className="w-8 h-8 rounded-full" />
                    )}
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-400">{p.id}</p>
                    </div>
                  </div>
                  {savedIds.has(p.id) ? (
                    <span className="text-xs text-green-600 font-bold">✓ Đã lưu</span>
                  ) : (
                    <button
                      onClick={() => savePage(p)}
                      className="px-3 py-1 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700"
                    >
                      Lưu
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {pages.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">
          Chưa có page nào. Nhấn &quot;Thêm trang&quot; để thêm Facebook Page.
        </div>
      ) : (
        <div className="space-y-2">
          {pages.map((p) => (
            <div
              key={p.page_id}
              className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-4"
            >
              <div className="flex items-center gap-3">
                {p.picture ? (
                  <img src={p.picture} alt={p.name} className="w-10 h-10 rounded-full" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm">
                    {p.name.charAt(0)}
                  </div>
                )}
                <div>
                  <p className="font-semibold text-slate-800 text-sm">{p.name}</p>
                  <p className="text-xs text-slate-400">{p.page_id}</p>
                </div>
              </div>
              <button
                onClick={() => onDelete(p.page_id)}
                className="text-xs text-red-500 hover:text-red-700 font-bold"
              >
                Xóa
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Post tab ──────────────────────────────────────────────────────────────────

function PostTab({
  pages,
  flash,
  onHistoryRefresh,
}: {
  pages: FbPage[];
  flash: (m: string, t?: "ok" | "err") => void;
  onHistoryRefresh: () => void;
}) {
  const [postType, setPostType] = useState("post");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function togglePage(pageId: string) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  async function handlePost() {
    if (selectedPages.size === 0) return flash("Chưa chọn page nào", "err");
    if (postType !== "story" && !title && !content) return flash("Cần nhập nội dung", "err");

    setSubmitting(true);
    const fd = new FormData();
    fd.append("post_type", postType);
    fd.append("title", title);
    fd.append("content", content);

    const pageList = pages
      .filter((p) => selectedPages.has(p.page_id))
      .map((p) => ({ page_id: p.page_id, name: p.name, access_token: p.access_token }));
    fd.append("pages", JSON.stringify(pageList));

    for (const img of images) fd.append("images", img);

    const r = await fetch(`${API}/api/facebook/post`, {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const d = await r.json();
    setSubmitting(false);

    if (!r.ok) return flash(d.detail || "Lỗi đăng bài", "err");

    const results: any[] = d.results || [];
    const ok = results.filter((x) => x.success).length;
    const fail = results.filter((x) => x.error).length;
    flash(`Đăng thành công ${ok} page${fail ? `, thất bại ${fail} page` : ""}`, fail ? "err" : "ok");
    onHistoryRefresh();
  }

  return (
    <div className="space-y-5">
      {/* Post type */}
      <div className="flex gap-3">
        {["post", "story"].map((t) => (
          <button
            key={t}
            onClick={() => setPostType(t)}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
              postType === t
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-slate-600 hover:bg-gray-200"
            }`}
          >
            {t === "post" ? "Bài viết" : "Story"}
          </button>
        ))}
      </div>

      {/* Content */}
      {postType === "post" && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Tiêu đề bài viết..."
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      )}
      {postType === "post" && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Nội dung bài viết..."
          rows={5}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      )}

      {/* Images */}
      <div>
        <input
          ref={fileRef}
          type="file"
          accept={postType === "story" ? "image/*,video/*" : "image/*"}
          multiple
          className="hidden"
          onChange={(e) => setImages(Array.from(e.target.files || []))}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-2 border border-dashed border-gray-300 rounded-lg text-xs text-slate-500 hover:border-blue-400 hover:text-blue-600"
        >
          {images.length > 0
            ? `${images.length} file đã chọn`
            : `Chọn ${postType === "story" ? "ảnh/video" : "ảnh"} (tuỳ chọn)`}
        </button>
        {images.length > 0 && (
          <button onClick={() => setImages([])} className="ml-2 text-xs text-red-400 hover:text-red-600">
            Xóa
          </button>
        )}
      </div>

      {/* Page selection */}
      <div>
        <p className="text-xs font-bold text-slate-600 mb-2">Chọn Pages để đăng:</p>
        {pages.length === 0 ? (
          <p className="text-xs text-slate-400">Chưa có page. Thêm page tại tab &quot;Quản lý Pages&quot;.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pages.map((p) => (
              <label
                key={p.page_id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedPages.has(p.page_id)
                    ? "border-blue-400 bg-blue-50"
                    : "border-gray-200 bg-white hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedPages.has(p.page_id)}
                  onChange={() => togglePage(p.page_id)}
                  className="accent-blue-600"
                />
                {p.picture ? (
                  <img src={p.picture} alt={p.name} className="w-7 h-7 rounded-full" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                    {p.name.charAt(0)}
                  </div>
                )}
                <span className="text-sm font-semibold text-slate-700 truncate">{p.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={handlePost}
        disabled={submitting || selectedPages.size === 0}
        className="px-6 py-2.5 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? "Đang đăng..." : "Đăng bài ngay"}
      </button>
    </div>
  );
}

// ── Schedule tab ──────────────────────────────────────────────────────────────

function ScheduleTab({
  pages,
  jobs,
  flash,
  onRefresh,
  onCancel,
}: {
  pages: FbPage[];
  jobs: ScheduledJob[];
  flash: (m: string, t?: "ok" | "err") => void;
  onRefresh: () => void;
  onCancel: (id: string) => void;
}) {
  const [postType, setPostType] = useState("post");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [autoCommentText, setAutoCommentText] = useState("");
  const [autoCommentTime, setAutoCommentTime] = useState("");
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function togglePage(pageId: string) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  async function handleSchedule() {
    if (selectedPages.size === 0) return flash("Chưa chọn page nào", "err");
    if (!schedTime) return flash("Chưa chọn thời gian", "err");
    if (postType !== "story" && !title && !content) return flash("Cần nhập nội dung", "err");

    setSubmitting(true);
    const fd = new FormData();
    fd.append("post_type", postType);
    fd.append("title", title);
    fd.append("content", content);
    fd.append("scheduled_time", new Date(schedTime).toISOString());
    fd.append("auto_comment_text", autoCommentText);
    fd.append("auto_comment_time", autoCommentTime ? new Date(autoCommentTime).toISOString() : "");

    const pageList = pages
      .filter((p) => selectedPages.has(p.page_id))
      .map((p) => ({ page_id: p.page_id, name: p.name, access_token: p.access_token }));
    fd.append("pages", JSON.stringify(pageList));

    for (const img of images) fd.append("images", img);

    const r = await fetch(`${API}/api/facebook/schedule/post`, {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    });
    const d = await r.json();
    setSubmitting(false);

    if (!r.ok) return flash(d.detail || "Lỗi đặt lịch", "err");
    flash(`Đã đặt lịch thành công cho ${d.count} page`);
    onRefresh();
  }

  const statusColor: Record<string, string> = {
    pending: "text-yellow-600 bg-yellow-50",
    running: "text-blue-600 bg-blue-50",
    done: "text-green-600 bg-green-50",
    failed: "text-red-600 bg-red-50",
    cancelled: "text-gray-500 bg-gray-50",
  };

  return (
    <div className="space-y-6">
      {/* Schedule form */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 space-y-4">
        <h3 className="font-bold text-slate-800 text-sm">Tạo lịch hẹn mới</h3>

        <div className="flex gap-3">
          {["post", "story"].map((t) => (
            <button
              key={t}
              onClick={() => setPostType(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                postType === t ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-slate-600"
              }`}
            >
              {t === "post" ? "Bài viết" : "Story"}
            </button>
          ))}
        </div>

        {postType === "post" && (
          <>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Tiêu đề..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Nội dung..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white resize-none"
            />
          </>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold text-slate-600 mb-1 block">Thời gian đăng</label>
            <input
              type="datetime-local"
              value={schedTime}
              onChange={(e) => setSchedTime(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            />
          </div>
          {postType === "post" && (
            <div>
              <label className="text-xs font-bold text-slate-600 mb-1 block">
                Auto-comment (tuỳ chọn)
              </label>
              <input
                value={autoCommentText}
                onChange={(e) => setAutoCommentText(e.target.value)}
                placeholder="Nội dung comment tự động..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              />
            </div>
          )}
          {autoCommentText && postType === "post" && (
            <div>
              <label className="text-xs font-bold text-slate-600 mb-1 block">Thời gian comment</label>
              <input
                type="datetime-local"
                value={autoCommentTime}
                onChange={(e) => setAutoCommentTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              />
            </div>
          )}
        </div>

        {/* Images */}
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={postType === "story" ? "image/*,video/*" : "image/*"}
            multiple
            className="hidden"
            onChange={(e) => setImages(Array.from(e.target.files || []))}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="px-3 py-2 border border-dashed border-gray-300 rounded-lg text-xs text-slate-500 hover:border-blue-400 hover:text-blue-600"
          >
            {images.length > 0 ? `${images.length} file đã chọn` : "Chọn ảnh/video (tuỳ chọn)"}
          </button>
          {images.length > 0 && (
            <button onClick={() => setImages([])} className="ml-2 text-xs text-red-400">
              Xóa
            </button>
          )}
        </div>

        {/* Page selection */}
        <div>
          <p className="text-xs font-bold text-slate-600 mb-2">Chọn Pages:</p>
          {pages.length === 0 ? (
            <p className="text-xs text-slate-400">Chưa có page.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {pages.map((p) => (
                <label
                  key={p.page_id}
                  className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer ${
                    selectedPages.has(p.page_id)
                      ? "border-blue-400 bg-blue-50"
                      : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPages.has(p.page_id)}
                    onChange={() => togglePage(p.page_id)}
                    className="accent-blue-600"
                  />
                  <span className="text-xs font-semibold text-slate-700 truncate">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleSchedule}
          disabled={submitting || selectedPages.size === 0}
          className="px-5 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "Đang đặt lịch..." : "Đặt lịch đăng bài"}
        </button>
      </div>

      {/* Scheduled jobs list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-800 text-sm">Danh sách lịch hẹn ({jobs.length})</h3>
          <button onClick={onRefresh} className="text-xs text-blue-600 hover:underline">
            Làm mới
          </button>
        </div>
        {jobs.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">Chưa có lịch hẹn nào.</div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-start justify-between bg-white border border-gray-200 rounded-lg p-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        statusColor[job.status] || "text-gray-600 bg-gray-50"
                      }`}
                    >
                      {job.status.toUpperCase()}
                    </span>
                    <span className="text-xs font-semibold text-slate-500 uppercase">{job.type}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-800 truncate">{job.description}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {new Date(job.scheduled_time).toLocaleString("vi-VN")}
                  </p>
                  {job.result && (
                    <p className="text-xs text-slate-500 mt-0.5 truncate">Kết quả: {job.result}</p>
                  )}
                </div>
                {job.status === "pending" && (
                  <button
                    onClick={() => onCancel(job.id)}
                    className="ml-3 text-xs text-red-500 hover:text-red-700 font-bold shrink-0"
                  >
                    Hủy
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

function HistoryTab({
  history,
  onRefresh,
}: {
  history: PostHistory[];
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-800 text-sm">Lịch sử đăng bài ({history.length})</h3>
        <button onClick={onRefresh} className="text-xs text-blue-600 hover:underline">
          Làm mới
        </button>
      </div>
      {history.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">Chưa có bài đăng nào.</div>
      ) : (
        <div className="space-y-2">
          {history.map((h) => (
            <div key={h.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                      {h.page_name}
                    </span>
                    {h.was_scheduled && (
                      <span className="text-xs text-slate-400">Đã hẹn giờ</span>
                    )}
                    {h.image_count > 0 && (
                      <span className="text-xs text-slate-400">{h.image_count} ảnh</span>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 line-clamp-2">{h.message || "(Story)"}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {new Date(h.posted_at).toLocaleString("vi-VN")}
                  </p>
                </div>
                {h.post_url && (
                  <a
                    href={h.post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline shrink-0"
                  >
                    Xem bài
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

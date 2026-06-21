"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Pagination from "../../../components/Pagination";
import { getApiBase } from "../../../lib/apiBase";

const API_BASE = getApiBase();

const QUICK_FILTERS = [
  { label: "Tất cả trạng thái", val: "" },
  { label: "Đang xếp hàng", val: "QUEUED" },
  { label: "Đang chạy", val: "RUNNING" },
  { label: "Thành công", val: "SUCCESS" },
  { label: "Thất bại", val: "FAILED" },
  { label: "Đang thử lại", val: "RETRYING" }
];

const STATUS_STYLES = {
  QUEUED: "bg-slate-50 text-slate-600 border-slate-200",
  PENDING: "bg-indigo-50 text-indigo-700 border-indigo-200",
  RUNNING: "bg-blue-50 text-blue-700 border-blue-200",
  SUCCESS: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  RETRYING: "bg-amber-50 text-amber-700 border-amber-200",
  CANCELLED: "bg-gray-100 text-gray-600 border-gray-200",
  SKIPPED: "bg-gray-100 text-gray-500 border-gray-200"
};

const STATUS_LABELS = {
  QUEUED: "Đang xếp hàng",
  PENDING: "Chờ xử lý",
  RUNNING: "Đang chạy",
  SUCCESS: "Thành công",
  FAILED: "Thất bại",
  RETRYING: "Đang thử lại",
  CANCELLED: "Đã hủy",
  SKIPPED: "Đã bỏ qua"
};

export default function JobsManagerPage() {
  const searchParams = useSearchParams();
  const campaignIdParam = searchParams.get("campaign_id") || "";

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState([]);

  const [currentPage, setCurrentPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Quick + advanced filters
  const [status, setStatus] = useState("");
  const [campaignId, setCampaignId] = useState(campaignIdParam);
  const [attemptMin, setAttemptMin] = useState<number | "">("");
  const [attemptMax, setAttemptMax] = useState<number | "">("");
  const [hasError, setHasError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(!!campaignIdParam);
  const [advancedActive, setAdvancedActive] = useState(!!campaignIdParam);
  const [searchTrigger, setSearchTrigger] = useState(0);

  const showToast = (message, type = "success") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const apiFetch = async (endpoint, options: any = {}) => {
    const token = sessionStorage.getItem("campaign_token");
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP error ${res.status}`);
      }
      return await res.json();
    } catch (err: any) {
      if (err.message === "Failed to fetch" || err.name === "TypeError") {
        throw new Error("Không thể kết nối đến máy chủ API.");
      }
      throw err;
    }
  };

  const fetchJobs = async () => {
    try {
      let endpoint;
      if (advancedActive) {
        const params = new URLSearchParams();
        if (campaignId) params.append("campaign_id", campaignId);
        if (status) params.append("status", status);
        if (attemptMin !== "") params.append("attempt_count_min", String(attemptMin));
        if (attemptMax !== "") params.append("attempt_count_max", String(attemptMax));
        if (hasError !== "") params.append("has_error", hasError);
        params.append("page", String(currentPage));
        params.append("limit", String(limit));
        endpoint = `/api/jobs/search/advanced?${params.toString()}`;
      } else {
        const params = new URLSearchParams();
        if (status) params.append("status", status);
        params.append("page", String(currentPage));
        params.append("limit", String(limit));
        endpoint = `/api/jobs?${params.toString()}`;
      }

      const data = await apiFetch(endpoint);
      if (data && data.items) {
        setJobs(data.items);
        setTotalItems(data.total);
        setTotalPages(data.pages);
      } else {
        setJobs(Array.isArray(data) ? data : []);
        setTotalItems(Array.isArray(data) ? data.length : 0);
        setTotalPages(1);
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [status, advancedActive, searchTrigger]);

  useEffect(() => {
    fetchJobs();
    let timer;
    if (!advancedActive) {
      timer = setInterval(fetchJobs, 3000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [status, currentPage, limit, advancedActive, searchTrigger]);

  const handleQuickFilter = (val) => {
    setStatus(val);
    setAdvancedActive(false);
  };

  const handleSearchClick = () => {
    setAdvancedActive(true);
    setSearchTrigger((t) => t + 1);
  };

  const handleResetAdvanced = () => {
    setCampaignId("");
    setAttemptMin("");
    setAttemptMax("");
    setHasError("");
    setAdvancedActive(false);
  };

  const retryJob = async (jobId) => {
    try {
      await apiFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      showToast("Đã kích hoạt chạy lại tác vụ bình luận!");
      fetchJobs();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const handleDelete = async (jobId) => {
    if (!confirm("Xóa job này?")) return;
    try {
      await apiFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      showToast("Đã xóa job thành công!");
      fetchJobs();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const handleBulkDelete = async (deleteStatus) => {
    if (!confirm(`Xóa tất cả jobs với trạng thái ${STATUS_LABELS[deleteStatus] || deleteStatus}?`)) return;
    try {
      const params = new URLSearchParams();
      if (campaignId) params.append("campaign_id", campaignId);
      params.append("status", deleteStatus);

      const data = await apiFetch(`/api/jobs/bulk-delete?${params.toString()}`, { method: "POST" });
      showToast(`Đã xóa ${data.deleted_count} jobs!`);
      fetchJobs();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const getJobPlatform = (job) => {
    if (job.platform) return job.platform;
    const targetUrl = job.target_url || "";
    if (targetUrl.includes("threads.net") || targetUrl.includes("threads.com")) return "Threads";
    return "X";
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-white">
        <p className="font-bold text-base text-gray-500">Đang tải danh sách jobs...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8 animate-slide-up">

      {/* Toast notifications */}
      <div className="fixed top-4 left-4 right-4 sm:left-auto sm:top-6 sm:right-6 z-50 space-y-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center px-5 py-3.5 rounded-md border text-sm font-bold tracking-wide transition-all shadow-none ${
              t.type === "error"
                ? "bg-red-50 border-red-200 text-red-600"
                : "bg-emerald-50 border-emerald-200 text-emerald-600"
            }`}
          >
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* Quick filter toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-50 border border-gray-200 p-5 rounded-lg gap-4 shadow-none">
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          {QUICK_FILTERS.map((btn) => (
            <button
              key={btn.val}
              onClick={() => handleQuickFilter(btn.val)}
              className={`px-4 h-10 rounded-md border transition-all duration-200 cursor-pointer shadow-none ${
                !advancedActive && status === btn.val
                  ? "bg-[#3B82F6] border-0 text-white hover:bg-blue-600"
                  : "bg-white border-gray-200 text-gray-700 hover:bg-gray-100"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <div className="text-xs font-extrabold uppercase tracking-wide text-gray-500 pl-1 sm:pr-1">
          Tìm thấy {totalItems} tác vụ
        </div>
      </div>

      {/* Advanced search panel */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg shadow-none p-5">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-gray-700 cursor-pointer"
        >
          <span>{showAdvanced ? "▼" : "▶"}</span>
          Tìm kiếm nâng cao
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-4 mt-4 border-t border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Campaign ID</label>
                <input
                  type="text"
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value)}
                  placeholder="Nhập Campaign ID"
                  className="w-full h-10 bg-white border border-gray-200 px-3 rounded-md text-xs font-semibold focus:outline-none focus:border-[#3B82F6] transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Số lần thử (Min)</label>
                <input
                  type="number"
                  min="0"
                  value={attemptMin}
                  onChange={(e) => setAttemptMin(e.target.value === "" ? "" : parseInt(e.target.value))}
                  className="w-full h-10 bg-white border border-gray-200 px-3 rounded-md text-xs font-semibold focus:outline-none focus:border-[#3B82F6] transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Số lần thử (Max)</label>
                <input
                  type="number"
                  min="0"
                  value={attemptMax}
                  onChange={(e) => setAttemptMax(e.target.value === "" ? "" : parseInt(e.target.value))}
                  className="w-full h-10 bg-white border border-gray-200 px-3 rounded-md text-xs font-semibold focus:outline-none focus:border-[#3B82F6] transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Có lỗi?</label>
                <select
                  value={hasError}
                  onChange={(e) => setHasError(e.target.value)}
                  className="w-full h-10 bg-white border border-gray-200 px-3 rounded-md text-xs font-bold text-gray-600 focus:outline-none focus:border-[#3B82F6] cursor-pointer transition-all"
                >
                  <option value="">Bất kỳ</option>
                  <option value="true">Có lỗi</option>
                  <option value="false">Không có lỗi</option>
                </select>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSearchClick}
                className="bg-[#3B82F6] hover:bg-blue-600 text-white font-extrabold px-4 h-10 rounded-md text-xs transition-all duration-200 cursor-pointer shadow-none"
              >
                Tìm kiếm
              </button>
              <button
                onClick={handleResetAdvanced}
                className="bg-white border border-gray-200 text-gray-600 hover:bg-gray-100 font-bold px-4 h-10 rounded-md text-xs transition-all duration-200 cursor-pointer shadow-none"
              >
                Đặt lại
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bulk delete */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg shadow-none p-5">
        <h3 className="text-xs font-extrabold uppercase tracking-wider text-gray-700 mb-3">Xóa hàng loạt</h3>
        <div className="flex flex-wrap gap-2">
          {["FAILED", "CANCELLED", "SKIPPED"].map((s) => (
            <button
              key={s}
              onClick={() => handleBulkDelete(s)}
              className="bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 font-bold px-4 h-10 rounded-md text-xs transition-all duration-200 cursor-pointer shadow-none"
            >
              Xóa tất cả {STATUS_LABELS[s] || s}
            </button>
          ))}
        </div>
      </div>

      {/* Table block */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 overflow-hidden shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-gray-400 uppercase tracking-widest font-extrabold">
                <th className="py-4 px-6">ID Tác Vụ</th>
                <th className="py-4 px-6">Nền Tảng</th>
                <th className="py-4 px-6">Tài Khoản</th>
                <th className="py-4 px-6">Đường Dẫn Đích</th>
                <th className="py-4 px-6">Nội Dung</th>
                <th className="py-4 px-6">Trạng Thái</th>
                <th className="py-4 px-6">Số Lần Thử</th>
                <th className="py-4 px-6">Thông Tin Lỗi</th>
                <th className="py-4 px-6 text-right">Thao Tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 text-gray-900 font-semibold">
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-gray-500 font-bold">Không tìm thấy tác vụ nào khớp với tiêu chí lọc.</td>
                </tr>
              ) : (
                jobs.map((job) => {
                  const platform = getJobPlatform(job);
                  return (
                    <tr key={job.id} className="hover:bg-gray-100/50 transition-colors duration-150">
                      <td className="py-4 px-6 font-mono text-[10px] text-gray-400">{job.id.substring(job.id.length - 8)}</td>
                      <td className="py-4 px-6">
                        <span className={`px-2.5 py-1 rounded text-[9px] font-bold uppercase border ${
                          platform === "Threads"
                            ? "bg-purple-50 text-purple-700 border-purple-200"
                            : platform === "Facebook"
                            ? "bg-blue-50 text-blue-700 border-blue-200"
                            : "bg-slate-900 text-white border-slate-900"
                        }`}>
                          {platform}
                        </span>
                      </td>
                      <td className="py-4 px-6 font-bold">@{job.account_username || "dynamic"}</td>
                      <td className="py-4 px-6 max-w-xs truncate text-gray-600" title={job.target_url}>{job.target_url}</td>
                      <td className="py-4 px-6 max-w-xs truncate text-gray-600" title={job.commented_text || job.template_content}>
                        "{job.commented_text || job.template_content}"
                      </td>
                      <td className="py-4 px-6">
                        <span className={`px-2.5 py-1 rounded text-[9px] font-extrabold uppercase border ${STATUS_STYLES[job.status] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                          {STATUS_LABELS[job.status] || job.status}
                        </span>
                      </td>
                      <td className="py-4 px-6 font-bold text-gray-500">{job.attempt_count}/3</td>
                      <td className="py-4 px-6 max-w-xs truncate font-mono text-red-600 text-[10px]" title={job.error_message}>
                        {job.error_message || "-"}
                      </td>
                      <td className="py-4 px-6 text-right">
                        <div className="inline-flex items-center gap-2">
                          {(job.status === "FAILED" || job.status === "CANCELLED") && (
                            <button
                              onClick={() => retryJob(job.id)}
                              className="bg-[#3B82F6] hover:bg-blue-600 text-white font-extrabold px-3 py-1.5 rounded-md text-[10px] transition-all duration-200 cursor-pointer shadow-none"
                            >
                              Chạy lại
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(job.id)}
                            disabled={["RUNNING", "QUEUED"].includes(job.status)}
                            className="bg-white border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed font-extrabold px-3 py-1.5 rounded-md text-[10px] transition-all duration-200 cursor-pointer shadow-none"
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={currentPage}
          limit={limit}
          total={totalItems}
          pages={totalPages}
          onPageChange={setCurrentPage}
          onLimitChange={(newLimit) => {
            setLimit(newLimit);
            setCurrentPage(1);
          }}
        />
      </div>

    </div>
  );
}

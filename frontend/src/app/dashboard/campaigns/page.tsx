"use client";

import { useState, useEffect, useRef } from "react";
import Pagination from "../../../components/Pagination";
import { getApiBase } from "../../../lib/apiBase";

const API_BASE = getApiBase();

const collectStrings = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
};

const uniqueList = (items: string[]): string[] => Array.from(new Set(items));

const formatVietnamDateTime = (value) => {
  if (!value) return "";
  const dateValue = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !(/[zZ]|[+-]\d{2}:\d{2}$/.test(value))
    ? `${value}Z`
    : value;
  return new Date(dateValue).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
};

const extractMonitorPageUrlsFromText = (value, platform) => {
  const raw = (value || "").trim();
  if (!raw) return [];

  let source = raw;
  try {
    source = collectStrings(JSON.parse(raw)).join("\n");
  } catch (err) {
    source = raw;
  }

  const urlMatches = source.match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|threads\.net|threads\.com)\/[^\s"'<>]+/gi) || [];
  const normalized = urlMatches
    .map((url) => url.replace(/[),.;\]]+$/, ""))
    .map((url) => (url.startsWith("http") ? url : `https://${url}`))
    .map((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        const firstSegment = parsed.pathname.split("/").filter(Boolean)[0] || "";
        const username = firstSegment.replace(/^@/, "");
        if (!username) return "";
        if ((host === "x.com" || host === "twitter.com") && platform === "X") {
          return `https://x.com/${username}`;
        }
        if ((host === "threads.net" || host === "threads.com") && platform === "Threads") {
          return `https://www.threads.net/@${username}`;
        }
      } catch (err) {
        return "";
      }
      return "";
    })
    .filter(Boolean);

  return uniqueList(normalized);
};

const extractUrlsFromText = (value, platform) => {
  const raw = (value || "").trim();
  if (!raw) return [];

  let source = raw;
  try {
    source = collectStrings(JSON.parse(raw)).join("\n");
  } catch (err) {
    source = raw;
  }

  if (platform === "Facebook") {
    const fbMatches = source.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi) || [];
    return uniqueList(fbMatches.map((u) => u.replace(/[),.;\]]+$/, "")));
  }

  // Support matching both threads.net and threads.com domains
  const urlMatches = source.match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|threads\.net|threads\.com)\/[^\s"'<>]+/gi) || [];
  const normalized = urlMatches
    .map((url) => url.replace(/[),.;\]]+$/, ""))
    .map((url) => (url.startsWith("http") ? url : `https://${url}`))
    .map((url) => url.replace(/^https:\/\/threads\.com\//i, "https://www.threads.com/"))
    .map((url) => url.replace(/^https:\/\/threads\.net\//i, "https://www.threads.net/"))
    .filter((url) => {
      if (platform === "X") return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/status\/\d+/i.test(url);
      if (platform === "Threads") return /https?:\/\/(?:www\.)?threads\.(?:net|com)\/@?[^/\s]+\/(?:post|t)\//i.test(url);
      return true;
    });

  return uniqueList(normalized);
};

const parseCommentTemplates = (value) => {
  const raw = (value || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const strings = Array.isArray(parsed)
      ? parsed.map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") return item.content || item.comment || item.text || item.message || "";
          return "";
        })
      : collectStrings(parsed);

    return uniqueList(strings.map((item) => item.trim()).filter(Boolean));
  } catch (err) {
    const blocks = raw.includes("\n\n")
      ? raw.split(/\r?\n\s*\r?\n/)
      : raw.split(/\r?\n/);

    return uniqueList(blocks.map((item) => item.trim()).filter(Boolean));
  }
};

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [campaignUrls, setCampaignUrls] = useState([]);
  const [campaignTemplates, setCampaignTemplates] = useState([]);
  const [campaignJobs, setCampaignJobs] = useState([]);
  const [platformAccounts, setPlatformAccounts] = useState([]);
  
  // Form and Modal States
  const [newCampaignName, setNewCampaignName] = useState("");
  const [newCampaignPlatform, setNewCampaignPlatform] = useState("X");
  const [newCampaignDesc, setNewCampaignDesc] = useState("");
  const [newCampaignType, setNewCampaignType] = useState("STATIC");
  const [newMonitorPageUrl, setNewMonitorPageUrl] = useState("");
  const [newMonitorInterval, setNewMonitorInterval] = useState(15);
  const [newRepeatEnabled, setNewRepeatEnabled] = useState(false);
  const [newRepeatInterval, setNewRepeatInterval] = useState(60);
  const [fbScheduleMode, setFbScheduleMode] = useState("");
  const [fbIntervalMinutes, setFbIntervalMinutes] = useState(30);
  const [fbFixedTimes, setFbFixedTimes] = useState("08:00,12:00,18:00");
  const [fbAccountId, setFbAccountId] = useState("");
  const [fbAccounts, setFbAccounts] = useState([]);
  const [fbAccountName, setFbAccountName] = useState("");
  const [fbPostImageMode, setFbPostImageMode] = useState("UPLOAD");
  const [fbPostImagePrompt, setFbPostImagePrompt] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [bulkUrls, setBulkUrls] = useState("");
  const [bulkTemplates, setBulkTemplates] = useState("");

  // Facebook structured template form
  const emptyFbPost = { content: "", image_url: "", first_comment: "", comment_delay_minutes: 0 };
  const [newFbPost, setNewFbPost] = useState(emptyFbPost);
  const [showAddFbPost, setShowAddFbPost] = useState(false);

  // Facebook CSV/Excel import
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvPreview, setCsvPreview] = useState<Array<{ content: string; image_url: string; first_comment: string; comment_delay_minutes: number }>>([]);
  const [csvImporting, setCsvImporting] = useState(false);

  const [toasts, setToasts] = useState([]);
  const selectedCampaignIdRef = useRef(null);
  const parsedBulkUrls = extractUrlsFromText(bulkUrls, selectedCampaign?.platform);
  const parsedBulkTemplates = parseCommentTemplates(bulkTemplates);
  const parsedNewMonitorPageUrls = extractMonitorPageUrlsFromText(newMonitorPageUrl, newCampaignPlatform);
  const selectedMonitorPageUrls = selectedCampaign
    ? extractMonitorPageUrlsFromText(
        (selectedCampaign.monitor_page_urls && selectedCampaign.monitor_page_urls.length > 0)
          ? selectedCampaign.monitor_page_urls.join("\n")
          : selectedCampaign.monitor_page_url || "",
        selectedCampaign.platform
      )
    : [];

  const showToast = (message, type = "success") => {
    const id = `${Date.now()}-${Math.random()}`;
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

  const loadCampaigns = async () => {
    try {
      const data = await apiFetch(`/api/campaigns?page=${currentPage}&limit=${limit}`);
      if (data && data.items) {
        setCampaigns(data.items);
        setTotalItems(data.total);
        setTotalPages(data.pages);
      } else {
        setCampaigns(Array.isArray(data) ? data : []);
        setTotalItems(Array.isArray(data) ? data.length : 0);
        setTotalPages(1);
      }
    } catch (err) {
      console.warn(err);
    }
  };

  useEffect(() => {
    loadCampaigns();
  }, [currentPage, limit]);

  const loadDetails = async (campaign) => {
    selectedCampaignIdRef.current = campaign.id;
    try {
      const [updated, urls, tpls, jobs] = await Promise.all([
        apiFetch(`/api/campaigns/${campaign.id}`),
        apiFetch(`/api/campaigns/${campaign.id}/urls`),
        apiFetch(`/api/campaigns/${campaign.id}/templates`),
        apiFetch(`/api/jobs?campaign_id=${campaign.id}`),
      ]);
      if (selectedCampaignIdRef.current !== campaign.id) return;
      setSelectedCampaign(updated);
      setCampaignUrls(urls);
      setCampaignTemplates(tpls);
      setCampaignJobs(jobs);

      // Load accounts for the campaign's platform
      const accs = await apiFetch(`/api/accounts?platform=${updated.platform}`);
      if (selectedCampaignIdRef.current !== campaign.id) return;
      setPlatformAccounts(accs);

      // Resolve Facebook Page name for display
      if (updated.platform === "Facebook" && updated.facebook_account_id) {
        try {
          const fbAcc = await apiFetch(`/api/accounts/${updated.facebook_account_id}`);
          if (selectedCampaignIdRef.current !== campaign.id) return;
          setFbAccountName(fbAcc.display_name || fbAcc.username || "");
        } catch {
          setFbAccountName("");
        }
      } else {
        setFbAccountName("");
      }
    } catch (err) {
      console.warn(err);
    }
  };

  // Poll selected campaign details to show real-time URL and Job updates
  useEffect(() => {
    if (!selectedCampaign) return;
    const campaignId = selectedCampaign.id;
    let active = true;
    
    const refreshData = async () => {
      try {
        const [updated, urls, tpls, jobs] = await Promise.all([
          apiFetch(`/api/campaigns/${campaignId}`),
          apiFetch(`/api/campaigns/${campaignId}/urls`),
          apiFetch(`/api/campaigns/${campaignId}/templates`),
          apiFetch(`/api/jobs?campaign_id=${campaignId}`),
        ]);
        if (!active) return;
        setSelectedCampaign(updated);
        setCampaignUrls(urls);
        setCampaignTemplates(tpls);
        setCampaignJobs(jobs);
      } catch (err) {
        console.warn("Poll details error:", err);
      }
    };

    const timer = setInterval(refreshData, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedCampaign?.id]);

  useEffect(() => {
    if (newCampaignPlatform === "Facebook") {
      apiFetch("/api/accounts?platform=Facebook").then((data) => {
        setFbAccounts(Array.isArray(data) ? data : data.items || []);
      }).catch(() => setFbAccounts([]));
    }
  }, [newCampaignPlatform]);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      if (newCampaignName.trim().length < 3) {
        showToast("Tên chiến dịch phải có ít nhất 3 ký tự.", "error");
        return;
      }
      if (newCampaignType === "MONITOR" && parsedNewMonitorPageUrls.length === 0) {
        showToast("Vui lòng nhập ít nhất một link profile/page hợp lệ để giám sát.", "error");
        return;
      }
      if (newCampaignPlatform === "Facebook" && !fbAccountId) {
        showToast("Vui lòng chọn Facebook Page để đăng bài.", "error");
        return;
      }

      const isFb = newCampaignPlatform === "Facebook";
      const fbFixedTimesList = fbFixedTimes.split(/[,;\s]+/).map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));

      const res = await apiFetch("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: newCampaignName,
          platform: newCampaignPlatform,
          description: newCampaignDesc,
          campaign_type: isFb ? "STATIC" : newCampaignType,
          monitor_page_url: newCampaignType === "MONITOR" ? parsedNewMonitorPageUrls[0] : null,
          monitor_page_urls: newCampaignType === "MONITOR" ? parsedNewMonitorPageUrls : [],
          monitor_interval: newCampaignType === "MONITOR" ? newMonitorInterval : null,
          repeat_enabled: isFb ? !!fbScheduleMode : (newCampaignType === "STATIC" ? newRepeatEnabled : false),
          repeat_interval_minutes: isFb ? null : (newCampaignType === "STATIC" && newRepeatEnabled ? newRepeatInterval : null),
          schedule_mode: isFb && fbScheduleMode ? fbScheduleMode : null,
          schedule_interval_minutes: isFb && fbScheduleMode === "interval" ? fbIntervalMinutes : null,
          schedule_fixed_times: isFb && fbScheduleMode === "fixed_times" ? fbFixedTimesList : null,
          facebook_account_id: isFb ? fbAccountId : null,
          post_image_mode: isFb ? fbPostImageMode : "UPLOAD",
          post_image_prompt: isFb && fbPostImageMode === "AI_GENERATED" ? (fbPostImagePrompt.trim() || null) : null,
        })
      });
      showToast("Tạo chiến dịch thành công!");
      setNewCampaignName("");
      setNewCampaignDesc("");
      setNewCampaignType("STATIC");
      setNewMonitorPageUrl("");
      setNewMonitorInterval(15);
      setNewRepeatEnabled(false);
      setNewRepeatInterval(60);
      setFbScheduleMode("");
      setFbIntervalMinutes(30);
      setFbFixedTimes("08:00,12:00,18:00");
      setFbAccountId("");
      setFbPostImageMode("UPLOAD");
      setFbPostImagePrompt("");
      setShowCreateModal(false);
      loadCampaigns();
      setSelectedCampaign(res);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleImportUrls = async () => {
    if (!bulkUrls.trim()) return;
    try {
      const urlsArray = extractUrlsFromText(bulkUrls, selectedCampaign?.platform);
      if (urlsArray.length === 0) {
        showToast("Không tìm thấy link bài viết hợp lệ. Link profile hãy nhập ở phần Link trang cần giám sát.", "error");
        return;
      }
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/urls/import`, {
        method: "POST",
        body: JSON.stringify({ urls: urlsArray })
      });
      setBulkUrls("");
      showToast("Nhập danh sách đường dẫn bài viết thành công!");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleImportTemplates = async () => {
    if (!bulkTemplates.trim()) return;
    try {
      const templatesArray = parseCommentTemplates(bulkTemplates);
      if (templatesArray.length === 0) {
        showToast("Không tìm thấy nội dung bình luận hợp lệ.", "error");
        return;
      }
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/templates`, {
        method: "POST",
        body: JSON.stringify({ templates: templatesArray })
      });
      setBulkTemplates("");
      showToast("Nhập danh sách mẫu bình luận thành công!");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const startCampaign = async (cid) => {
    if (selectedCampaign?.platform !== "Facebook") {
      if (selectedCampaign?.campaign_type !== "MONITOR" && campaignUrls.length === 0) {
        showToast("Vui lòng nhập ít nhất một link bài viết trước khi chạy chiến dịch.", "error");
        return;
      }
      if (selectedCampaign?.campaign_type === "MONITOR" && selectedMonitorPageUrls.length === 0) {
        showToast("Vui lòng nhập ít nhất một link profile/page cần giám sát trước khi chạy chiến dịch.", "error");
        return;
      }
    }
    if (campaignTemplates.length === 0) {
      showToast("Vui lòng nhập ít nhất một nội dung bài đăng trước khi chạy chiến dịch.", "error");
      return;
    }
    try {
      await apiFetch(`/api/campaigns/${cid}/start`, { method: "POST" });
      showToast("Đã kích hoạt chạy chiến dịch thành công!");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const pauseCampaign = async (cid) => {
    try {
      await apiFetch(`/api/campaigns/${cid}/pause`, { method: "POST" });
      showToast("Đã tạm dừng chiến dịch.", "warning");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const stopCampaign = async (cid) => {
    try {
      await apiFetch(`/api/campaigns/${cid}/stop`, { method: "POST" });
      showToast("Đã dừng và hoàn tất chiến dịch.", "error");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const duplicateCampaign = async (cid) => {
    try {
      const res = await apiFetch(`/api/campaigns/${cid}/duplicate`, { method: "POST" });
      showToast("Nhân bản chiến dịch thành công!");
      loadCampaigns();
      // Select duplicate
      const dup = { id: res.new_campaign_id };
      loadDetails(dup);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const deleteCampaign = async (cid) => {
    if (!confirm("Bạn có chắc chắn muốn xóa chiến dịch này? Tất cả các đường dẫn bài viết, nội dung bình luận và lịch sử tác vụ liên quan sẽ bị xóa vĩnh viễn.")) return;
    try {
      await apiFetch(`/api/campaigns/${cid}`, { method: "DELETE" });
      showToast("Đã xóa chiến dịch thành công.", "error");
      setSelectedCampaign(null);
      loadCampaigns();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const retryAllFailed = async (cid) => {
    try {
      await apiFetch(`/api/jobs/retry-failed-campaign/${cid}`, { method: "POST" });
      showToast("Đã gửi yêu cầu chạy lại toàn bộ tác vụ thất bại!");
      loadDetails(selectedCampaign);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const assignAccountToUrl = async (urlId, accountId) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/urls/${urlId}/assign-account`, {
        method: "PUT",
        body: JSON.stringify({ account_id: accountId || null })
      });
      showToast(accountId ? "Đã gán tài khoản cho bài viết!" : "Đã bỏ gán tài khoản.");
      // Refresh URLs to get updated assignment
      const urls = await apiFetch(`/api/campaigns/${selectedCampaign.id}/urls`);
      setCampaignUrls(urls);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const assignAccountToAll = async (accountId) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/urls/assign-account-all`, {
        method: "PUT",
        body: JSON.stringify({ account_id: accountId || null })
      });
      showToast(accountId ? "Đã gán tài khoản cho tất cả bài viết!" : "Đã bỏ gán tất cả.");
      const urls = await apiFetch(`/api/campaigns/${selectedCampaign.id}/urls`);
      setCampaignUrls(urls);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const getStatusText = (s) => {
    if (s === "RUNNING") return "Đang chạy";
    if (s === "COMPLETED") return "Hoàn thành";
    if (s === "STOPPED") return "Đã dừng";
    if (s === "FAILED") return "Thất bại";
    if (s === "PAUSED") return "Tạm dừng";
    if (s === "DRAFT") return "Bản nháp";
    if (s === "READY") return "Sẵn sàng";
    return s;
  };

  const getJobStatusText = (s) => {
    if (s === "SUCCESS") return "Thành công";
    if (s === "FAILED") return "Thất bại";
    if (s === "RUNNING") return "Đang chạy";
    if (s === "QUEUED") return "Đang xếp hàng";
    if (s === "RETRYING") return "Đang thử lại";
    if (s === "CANCELLED") return "Đã hủy";
    return s || "Chưa tạo job";
  };

  const getJobsForUrl = (url) => {
    return campaignJobs
      .filter((job) => job.url_id === url.id || job.target_url === url.url)
      .sort((a, b) => new Date(a.scheduled_time || a.completed_at || 0).getTime() - new Date(b.scheduled_time || b.completed_at || 0).getTime());
  };

  const getStatusForUrlJobs = (jobs, urlStatus) => {
    if (jobs.length === 0) return urlStatus;
    if (jobs.some((job) => job.status === "RUNNING")) return "RUNNING";
    if (jobs.some((job) => job.status === "QUEUED")) return "QUEUED";
    if (jobs.some((job) => job.status === "RETRYING")) return "RETRYING";
    if (jobs.some((job) => job.status === "FAILED")) return "FAILED";
    if (jobs.some((job) => job.status === "CANCELLED")) return "CANCELLED";
    if (jobs.every((job) => job.status === "SUCCESS")) return "SUCCESS";
    return jobs[jobs.length - 1]?.status || urlStatus;
  };

  const getStatusForUrl = (url) => getStatusForUrlJobs(getJobsForUrl(url), url.status);

  const completedUrlCount = campaignUrls.filter((url) => getStatusForUrl(url) === "SUCCESS").length;

  const uploadImage = async (file: File): Promise<string | null> => {
    const form = new FormData();
    form.append("file", file);
    const token = sessionStorage.getItem("campaign_token");
    try {
      const res = await fetch(`${API_BASE}/api/media/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Upload thất bại");
      }
      const data = await res.json();
      return data.url as string;
    } catch (err: any) {
      showToast(err.message, "error");
      return null;
    }
  };

  const addFbTemplate = async () => {
    if (!newFbPost.content.trim()) {
      showToast("Vui lòng nhập nội dung bài đăng.", "error");
      return;
    }
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/templates/facebook`, {
        method: "POST",
        body: JSON.stringify({
          content: newFbPost.content.trim(),
          image_url: newFbPost.image_url.trim() || null,
          first_comment: newFbPost.first_comment.trim() || null,
          comment_delay_minutes: Number(newFbPost.comment_delay_minutes) || 0,
        })
      });
      setNewFbPost(emptyFbPost);
      setShowAddFbPost(false);
      showToast("Đã thêm bài đăng!");
      loadDetails(selectedCampaign);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const updateFbTemplate = async (templateId: string, patch: object) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/templates/${templateId}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      loadDetails(selectedCampaign);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const deleteFbTemplate = async (templateId: string) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}/templates/${templateId}`, { method: "DELETE" });
      showToast("Đã xóa bài đăng.");
      loadDetails(selectedCampaign);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const handleCsvFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      let dataRows = rows;
      if (rows.length > 0) {
        const first = String(rows[0][0] || "").toLowerCase().trim();
        if (first === "content" || first === "nội dung" || first === "noi dung") {
          dataRows = rows.slice(1);
        }
      }
      const parsed = dataRows
        .filter((row) => String(row[0] || "").trim())
        .map((row) => ({
          content: String(row[0] || "").trim(),
          image_url: String(row[1] || "").trim(),
          first_comment: String(row[2] || "").trim(),
          comment_delay_minutes: Number(row[3]) || 0,
        }));
      setCsvPreview(parsed);
    } catch {
      showToast("Không đọc được file. Vui lòng kiểm tra định dạng CSV/Excel.", "error");
    }
    e.target.value = "";
  };

  const handleCsvBulkImport = async () => {
    if (csvPreview.length === 0 || !selectedCampaign) return;
    setCsvImporting(true);
    try {
      const payload = csvPreview.map((row) => ({
        content: row.content,
        image_url: row.image_url || null,
        first_comment: row.first_comment || null,
        comment_delay_minutes: row.comment_delay_minutes,
      }));
      const res = await apiFetch(`/api/campaigns/${selectedCampaign.id}/templates/facebook/bulk`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setShowCsvModal(false);
      setCsvPreview([]);
      showToast(`Đã import ${res.inserted} bài đăng thành công!`);
      loadDetails(selectedCampaign);
    } catch (err: any) {
      showToast(err.message || "Import thất bại", "error");
    } finally {
      setCsvImporting(false);
    }
  };

  const updateRepeatSchedule = async (payload) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      showToast("Cập nhật lịch chạy lặp lại thành công!");
      const updated = await apiFetch(`/api/campaigns/${selectedCampaign.id}`);
      setSelectedCampaign(updated);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const updateCampaignImageSettings = async (payload) => {
    try {
      await apiFetch(`/api/campaigns/${selectedCampaign.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      showToast("Cập nhật cấu hình ảnh comment thành công!");
      const updated = await apiFetch(`/api/campaigns/${selectedCampaign.id}`);
      setSelectedCampaign(updated);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-6 items-start pb-8 animate-slide-in">
      
      {/* Toast notifications handler */}
      <div className="fixed top-4 left-4 right-4 sm:left-auto sm:top-6 sm:right-6 z-50 space-y-3">
        {toasts.map((t) => (
          <div 
            key={t.id} 
            className={`flex items-center px-5 py-3.5 rounded-md border text-sm font-bold tracking-wide transition-all shadow-none ${
              t.type === "error" 
                ? "bg-red-50 border-red-200 text-red-600"
                : t.type === "warning"
                ? "bg-amber-50 border-amber-200 text-amber-600"
                : "bg-emerald-50 border-emerald-200 text-emerald-600"
            }`}
          >
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* Left Col: Folders list */}
      <div className="space-y-3 min-w-0">
        <div className="flex justify-between items-center gap-2 pr-1 pl-1">
          <h3 className="text-xs font-extrabold text-gray-900 uppercase tracking-wider leading-tight">Danh mục chiến dịch</h3>
          <button
            onClick={() => setShowCreateModal(true)}
            className="h-9 bg-[#3B82F6] hover:bg-blue-600 text-white font-extrabold px-3 rounded-md text-[10px] transition-all duration-200 hover:scale-105 cursor-pointer shadow-none shrink-0"
          >
            + Tạo mới
          </button>
        </div>

        {campaigns.length === 0 ? (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500 font-bold text-xs shadow-none">
            Chưa có chiến dịch nào được tạo. Chọn nút bên trên để khởi tạo một chiến dịch.
          </div>
        ) : (
          <div className="space-y-2 max-h-[calc(100vh-205px)] overflow-y-auto pr-1">
            {campaigns.map((camp) => (
              <button
                key={camp.id}
                onClick={() => loadDetails(camp)}
                className={`w-full text-left p-3 rounded-md border transition-all duration-200 cursor-pointer shadow-none ${
                  selectedCampaign?.id === camp.id
                    ? "bg-white border-[#3B82F6]/50 hover:bg-gray-50/50"
                    : "bg-gray-50 border-gray-200 hover:bg-gray-100/80"
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="min-w-0 truncate font-extrabold text-gray-900 text-xs leading-5">{camp.name}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${
                    camp.status === "RUNNING"
                      ? "bg-blue-50 text-blue-700 border border-blue-200"
                      : camp.status === "COMPLETED"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : camp.status === "FAILED"
                      ? "bg-red-50 text-red-700 border border-red-200"
                      : camp.status === "STOPPED"
                      ? "bg-slate-100 text-slate-700 border border-slate-200"
                      : camp.status === "PAUSED"
                      ? "bg-amber-50 text-amber-700 border border-amber-200"
                      : "bg-gray-100 text-gray-600 border border-gray-200"
                  }`}>
                    {getStatusText(camp.status)}
                  </span>
                </div>
                <p className="text-gray-500 text-[11px] font-semibold mt-1.5 truncate">{camp.description || "Không có mô tả chiến dịch."}</p>
                <div className="flex justify-between items-center gap-2 text-[8px] text-gray-400 font-extrabold mt-2.5 pt-2 border-t border-gray-200 uppercase tracking-widest">
                  <span className="truncate">{camp.platform}</span>
                  <span className="truncate">@{camp.created_by}</span>
                </div>
              </button>
            ))}
          </div>
        )}
        <Pagination
          page={currentPage}
          limit={limit}
          total={totalItems}
          pages={totalPages}
          onPageChange={setCurrentPage}
        />
      </div>

      {/* Right Col: Details View */}
      <div className="min-w-0">
        {selectedCampaign ? (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-7 space-y-7 shadow-none">
            
            {/* Title & Toolbar */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-gray-200 pb-5 gap-4">
              <div>
                <div className="flex items-center space-x-2.5">
                  <h2 className="text-base font-extrabold text-gray-900 tracking-tight leading-none uppercase">{selectedCampaign.name}</h2>
                  <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded ${
                    selectedCampaign.platform === "X"
                      ? "bg-blue-50 text-blue-700 border border-blue-200"
                      : selectedCampaign.platform === "Facebook"
                      ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                      : "bg-purple-50 text-purple-700 border border-purple-200"
                  }`}>
                    {selectedCampaign.platform}
                  </span>
                </div>
                <p className="text-gray-500 text-xs font-semibold mt-2">{selectedCampaign.description || "Không có mô tả chiến dịch."}</p>
              </div>

              <div className="flex flex-wrap gap-2">
                  {selectedCampaign.status !== "RUNNING" ? (
                    <button
                      onClick={() => startCampaign(selectedCampaign.id)}
                      className="h-10 bg-[#10B981] hover:bg-emerald-600 text-white font-extrabold px-4 rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
                    >
                      ▶️ Chạy
                    </button>
                  ) : (
                    <button
                      onClick={() => pauseCampaign(selectedCampaign.id)}
                      className="h-10 bg-[#F59E0B] hover:bg-amber-600 text-white font-extrabold px-4 rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
                    >
                      ⏸️ Tạm dừng
                    </button>
                  )}
                  
                  {selectedCampaign.status === "RUNNING" && (
                    <button
                      onClick={() => stopCampaign(selectedCampaign.id)}
                      className="h-10 bg-red-500 hover:bg-red-600 text-white font-extrabold px-4 rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
                    >
                      Dừng chạy
                    </button>
                  )}

                  <button
                    onClick={() => duplicateCampaign(selectedCampaign.id)}
                    className="h-10 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-extrabold px-4 rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
                  >
                    Nhân bản
                  </button>
                  
                  <button
                    onClick={() => deleteCampaign(selectedCampaign.id)}
                    className="h-10 bg-red-50 hover:bg-red-100 border border-red-200 text-red-600 font-extrabold px-4 rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
                  >
                    Xóa
                  </button>
              </div>
            </div>

            {/* Campaign Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {selectedCampaign.platform === "Facebook" ? (() => {
                const publishedCount = campaignTemplates.filter(t => t.published_at).length;
                const totalCount = campaignTemplates.length;
                const pct = totalCount > 0 ? Math.round((publishedCount / totalCount) * 100) : 0;
                return (
                  <>
                    <div className="bg-white border border-gray-200 p-4 rounded-md shadow-none">
                      <p className="text-[10px] font-extrabold uppercase text-gray-400 tracking-widest">Tiến độ đăng bài</p>
                      <p className="text-xl font-extrabold text-gray-900 mt-1">{publishedCount}<span className="text-sm text-gray-400 font-bold">/{totalCount}</span></p>
                      {totalCount > 0 && (
                        <div className="mt-2 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                      <p className="text-[9px] text-gray-400 font-bold mt-1">{totalCount - publishedCount} bài chờ đăng</p>
                    </div>
                    <div className="bg-white border border-gray-200 p-4 rounded-md shadow-none">
                      <p className="text-[10px] font-extrabold uppercase text-gray-400 tracking-widest">Lần chạy kế tiếp</p>
                      {selectedCampaign.next_run_at ? (
                        <p className="text-xs font-extrabold text-indigo-600 mt-2 leading-snug">{formatVietnamDateTime(selectedCampaign.next_run_at)}</p>
                      ) : (
                        <p className="text-sm font-extrabold text-gray-300 mt-2.5">—</p>
                      )}
                    </div>
                  </>
                );
              })() : (
                <>
                  <div className="bg-white border border-gray-200 p-4 rounded-md text-center shadow-none">
                    <p className="text-[10px] font-extrabold uppercase text-gray-400 tracking-widest">Đường dẫn bài viết</p>
                    <p className="text-xl font-extrabold text-gray-900 mt-1">{campaignUrls.length}</p>
                  </div>
                  <div className="bg-white border border-gray-200 p-4 rounded-md text-center shadow-none">
                    <p className="text-[10px] font-extrabold uppercase text-gray-400 tracking-widest">Mẫu bình luận loaded</p>
                    <p className="text-xl font-extrabold text-gray-900 mt-1">{campaignTemplates.length}</p>
                  </div>
                </>
              )}
              <div className="bg-white border border-gray-200 p-4 rounded-md text-center shadow-none">
                <p className="text-[10px] font-extrabold uppercase text-gray-400 tracking-widest">Trạng thái chạy</p>
                <p className="text-sm font-extrabold text-[#3B82F6] mt-2.5 uppercase tracking-wider">
                  {getStatusText(selectedCampaign.status)}
                </p>
              </div>
            </div>

            {/* Campaign Configuration Panel */}
            {(["DRAFT", "READY", "PAUSED"].includes(selectedCampaign.status) || selectedCampaign.campaign_type === "MONITOR") ? (
              <div className="bg-white border border-gray-200 p-5 rounded-md text-xs font-bold text-gray-600 space-y-4 shadow-none">
                <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500 border-b pb-2">
                  {selectedCampaign.platform === "Facebook" ? "Cấu hình lịch đăng bài" : "Cấu hình giám sát & Thông tin"}
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {selectedCampaign.platform !== "Facebook" && (
                  <div>
                    <label className="block mb-1.5 ml-0.5 text-gray-500">Loại chiến dịch</label>
                    {["DRAFT", "READY", "PAUSED"].includes(selectedCampaign.status) ? (
                      <select
                        value={selectedCampaign.campaign_type || "STATIC"}
                        onChange={async (e) => {
                          const newType = e.target.value;
                          try {
                            await apiFetch(`/api/campaigns/${selectedCampaign.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ campaign_type: newType })
                            });
                            showToast("Cập nhật loại chiến dịch thành công!");
                            const updated = await apiFetch(`/api/campaigns/${selectedCampaign.id}`);
                            setSelectedCampaign(updated);
                          } catch (err: any) {
                            showToast(err.message, "error");
                          }
                        }}
                        className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                      >
                        <option value="STATIC">Thủ công (Nhập bài đăng trực tiếp)</option>
                        <option value="MONITOR">Tự động (Giám sát trang bài viết mới nhất)</option>
                      </select>
                    ) : (
                      <div className="h-10 flex items-center bg-gray-55 border border-gray-200 rounded px-3 text-xs font-extrabold text-gray-900">
                        Tự động (Giám sát trang bài viết mới nhất)
                      </div>
                    )}
                  </div>
                  )}

                  {selectedCampaign.campaign_type === "MONITOR" && (
                    <div>
                      <label className="block mb-1.5 ml-0.5 text-gray-500">Tần suất kiểm tra</label>
                      <select
                        value={selectedCampaign.monitor_interval || 15}
                        onChange={async (e) => {
                          const newInt = Number(e.target.value);
                          try {
                            await apiFetch(`/api/campaigns/${selectedCampaign.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ monitor_interval: newInt })
                            });
                            showToast("Cập nhật tần suất kiểm tra thành công!");
                            const updated = await apiFetch(`/api/campaigns/${selectedCampaign.id}`);
                            setSelectedCampaign(updated);
                          } catch (err: any) {
                            showToast(err.message, "error");
                          }
                        }}
                        className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                      >
                        <option value={1}>1 phút (Để test nhanh)</option>
                        <option value={5}>5 phút</option>
                        <option value={15}>15 phút</option>
                        <option value={30}>30 phút</option>
                        <option value={60}>1 giờ</option>
                      </select>
                    </div>
                  )}

                  {selectedCampaign.campaign_type !== "MONITOR" && selectedCampaign.platform !== "Facebook" && (
                    <div>
                      <label className="block mb-1.5 ml-0.5 text-gray-500">Lịch chạy lặp lại</label>
                      <select
                        value={selectedCampaign.repeat_enabled ? String(selectedCampaign.repeat_interval_minutes || 60) : "off"}
                        onChange={(e) => {
                          if (e.target.value === "off") {
                            updateRepeatSchedule({ repeat_enabled: false });
                            return;
                          }
                          updateRepeatSchedule({
                            repeat_enabled: true,
                            repeat_interval_minutes: Number(e.target.value)
                          });
                        }}
                        className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                      >
                        <option value="off">Không tự chạy lại</option>
                        <option value={5}>Mỗi 5 phút</option>
                        <option value={15}>Mỗi 15 phút</option>
                        <option value={30}>Mỗi 30 phút</option>
                        <option value={60}>Mỗi 1 giờ</option>
                        <option value={360}>Mỗi 6 giờ</option>
                        <option value={1440}>Mỗi ngày</option>
                      </select>
                      {selectedCampaign.repeat_enabled && (
                        <p className="mt-1.5 text-[10px] font-bold text-gray-400">
                          Lần chạy kế tiếp: {selectedCampaign.next_run_at ? formatVietnamDateTime(selectedCampaign.next_run_at) : "sau khi vòng hiện tại hoàn tất"}
                        </p>
                      )}
                    </div>
                  )}

                  {selectedCampaign.platform === "Facebook" && (
                    <div className="col-span-2 rounded-md border border-indigo-200 bg-indigo-50 p-4 space-y-3">
                      <p className="text-[10px] font-extrabold uppercase text-indigo-600 tracking-wide">Cấu hình Facebook Page</p>
                      {fbAccountName && (
                        <p className="text-xs font-bold text-gray-700">
                          Facebook Page: <span className="text-indigo-700">{fbAccountName}</span>
                        </p>
                      )}
                      <div>
                        <label className="block mb-1.5 text-xs font-bold text-gray-700">Lịch đăng bài</label>
                        <select
                          value={selectedCampaign.schedule_mode || ""}
                          onChange={async (e) => {
                            const mode = e.target.value;
                            const payload: any = { schedule_mode: mode || null, repeat_enabled: !!mode };
                            if (mode === "interval") {
                              const mins = selectedCampaign.repeat_interval_minutes || 30;
                              payload.schedule_interval_minutes = mins;
                              payload.repeat_interval_minutes = mins;
                            }
                            if (!mode) { payload.next_run_at = null; }
                            await updateRepeatSchedule(payload);
                          }}
                          className="w-full h-10 bg-white border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:outline-none cursor-pointer"
                        >
                          <option value="">Chạy một lần (không lặp lại)</option>
                          <option value="interval">Lặp theo khoảng thời gian (phút)</option>
                          <option value="fixed_times">Lặp theo giờ cố định trong ngày</option>
                        </select>
                      </div>
                      {selectedCampaign.schedule_mode === "interval" && (
                        <div>
                          <label className="block mb-1.5 text-xs font-bold text-gray-700">Khoảng cách giữa các lần (phút)</label>
                          <select
                            value={selectedCampaign.repeat_interval_minutes || 30}
                            onChange={async (e) => {
                              const mins = Number(e.target.value);
                              await updateRepeatSchedule({ schedule_interval_minutes: mins, repeat_interval_minutes: mins });
                            }}
                            className="w-full h-10 bg-white border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:outline-none cursor-pointer"
                          >
                            <option value={5}>Mỗi 5 phút</option>
                            <option value={10}>Mỗi 10 phút</option>
                            <option value={15}>Mỗi 15 phút</option>
                            <option value={30}>Mỗi 30 phút</option>
                            <option value={60}>Mỗi 1 giờ</option>
                            <option value={120}>Mỗi 2 giờ</option>
                            <option value={240}>Mỗi 4 giờ</option>
                            <option value={480}>Mỗi 8 giờ</option>
                            <option value={720}>Mỗi 12 giờ</option>
                            <option value={1440}>Mỗi 24 giờ</option>
                          </select>
                        </div>
                      )}
                      {selectedCampaign.schedule_mode === "fixed_times" && (
                        <div>
                          <label className="block mb-1.5 text-xs font-bold text-gray-700">Giờ cố định trong ngày (HH:MM)</label>
                          <input
                            type="text"
                            key={selectedCampaign.id}
                            defaultValue={(selectedCampaign.schedule_fixed_times || []).join(", ")}
                            placeholder="Ví dụ: 08:00, 12:00, 18:00"
                            onBlur={async (e) => {
                              const times = e.target.value.split(/[,;\s]+/).map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
                              if (times.length === 0) return;
                              await updateRepeatSchedule({ schedule_fixed_times: times });
                            }}
                            className="w-full h-10 bg-white border border-gray-200 rounded px-3 text-xs font-semibold text-gray-900 focus:outline-none"
                          />
                          <span className="text-[10px] text-gray-400 font-medium mt-1 block">Giờ theo múi giờ Việt Nam (GMT+7). Cách nhau bằng dấu phẩy.</span>
                        </div>
                      )}
                      {selectedCampaign.next_run_at && (
                        <p className="text-[10px] font-bold text-indigo-500">
                          Lần chạy kế tiếp: {formatVietnamDateTime(selectedCampaign.next_run_at)}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {selectedCampaign.campaign_type === "MONITOR" && (
                  <div>
                    <label className="block mb-1.5 ml-0.5 text-gray-500">Link trang cần giám sát</label>
                    <textarea
                      key={selectedCampaign.id}
                      placeholder={selectedCampaign.platform === "X" ? "Ví dụ: https://x.com/elonmusk" : "Ví dụ: https://www.threads.net/@zuck"}
                      defaultValue={selectedMonitorPageUrls.join("\n")}
                      rows={4}
                      onBlur={async (e) => {
                        const urls = extractMonitorPageUrlsFromText(e.target.value, selectedCampaign.platform);
                        if (urls.join("\n") === selectedMonitorPageUrls.join("\n")) return;
                        if (urls.length === 0) {
                          showToast("Vui lòng nhập ít nhất một link profile/page hợp lệ để giám sát.", "error");
                          return;
                        }
                        try {
                          await apiFetch(`/api/campaigns/${selectedCampaign.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              monitor_page_url: urls[0] || null,
                              monitor_page_urls: urls,
                            })
                          });
                          showToast("Cập nhật link trang giám sát thành công!");
                          const updated = await apiFetch(`/api/campaigns/${selectedCampaign.id}`);
                          setSelectedCampaign(updated);
                        } catch (err: any) {
                          showToast(err.message, "error");
                        }
                      }}
                      className="w-full bg-gray-55 border border-gray-200 rounded px-3 py-2 text-xs font-semibold text-gray-900 focus:bg-white focus:outline-none resize-none"
                    />
                    <p className="mt-1.5 text-[10px] font-bold text-gray-400">Mỗi dòng một profile/page link. Đã nhận {selectedMonitorPageUrls.length} link giám sát.</p>
                  </div>
                )}
              </div>
            ) : (
              selectedCampaign.campaign_type === "MONITOR" && (
                <div className="bg-white border border-gray-200 p-5 rounded-md text-xs font-bold text-gray-600 space-y-2 shadow-none">
                  <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500 border-b pb-2">Thông tin giám sát trang</h4>
                  <p className="text-gray-700">Loại chiến dịch: <span className="text-gray-900 font-extrabold">Tự động (Giám sát trang)</span></p>
                  <div className="text-gray-700">
                    <p>Trang giám sát: <span className="text-gray-900 font-extrabold">{selectedMonitorPageUrls.length} link</span></p>
                    <div className="mt-1 space-y-1">
                      {selectedMonitorPageUrls.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="block truncate text-[#3B82F6] hover:underline font-mono">{url}</a>
                      ))}
                    </div>
                  </div>
                  <p className="text-gray-700">Tần suất kiểm tra: <span className="text-gray-900 font-extrabold">{selectedCampaign.monitor_interval} phút</span></p>
                  {selectedCampaign.last_monitored_at && (
                    <p className="text-gray-400 text-[10px]">Lần quét gần nhất: {formatVietnamDateTime(selectedCampaign.last_monitored_at)}</p>
                  )}
                </div>
              )
            )}

            {selectedCampaign.campaign_type !== "MONITOR" &&
              !["DRAFT", "READY", "PAUSED"].includes(selectedCampaign.status) && (
                <div className="bg-white border border-gray-200 p-5 rounded-md text-xs font-bold text-gray-600 space-y-3 shadow-none">
                  <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500 border-b pb-2">Lịch chạy lặp lại</h4>
                  {selectedCampaign.platform === "Facebook" ? (
                    <div className="space-y-3">
                      {fbAccountName && (
                        <p className="text-xs font-bold text-gray-700">Facebook Page: <span className="text-indigo-700">{fbAccountName}</span></p>
                      )}
                      <div>
                        <label className="block mb-1.5 text-[10px] font-extrabold text-gray-500 uppercase tracking-wide">Chế độ lặp lại</label>
                        <select
                          value={selectedCampaign.schedule_mode || ""}
                          onChange={async (e) => {
                            const mode = e.target.value;
                            const payload: any = { schedule_mode: mode || null, repeat_enabled: !!mode };
                            if (mode === "interval") {
                              const mins = selectedCampaign.repeat_interval_minutes || 30;
                              payload.schedule_interval_minutes = mins;
                              payload.repeat_interval_minutes = mins;
                            }
                            if (!mode) { payload.next_run_at = null; }
                            await updateRepeatSchedule(payload);
                          }}
                          className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                        >
                          <option value="">Chạy một lần (không lặp lại)</option>
                          <option value="interval">Lặp theo khoảng thời gian (phút)</option>
                          <option value="fixed_times">Lặp theo giờ cố định trong ngày</option>
                        </select>
                      </div>
                      {selectedCampaign.schedule_mode === "interval" && (
                        <div>
                          <label className="block mb-1.5 text-[10px] font-extrabold text-gray-500 uppercase tracking-wide">Khoảng cách giữa các lần (phút)</label>
                          <select
                            value={selectedCampaign.repeat_interval_minutes || 30}
                            onChange={async (e) => {
                              const mins = Number(e.target.value);
                              await updateRepeatSchedule({ schedule_interval_minutes: mins, repeat_interval_minutes: mins });
                            }}
                            className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                          >
                            <option value={5}>Mỗi 5 phút</option>
                            <option value={10}>Mỗi 10 phút</option>
                            <option value={15}>Mỗi 15 phút</option>
                            <option value={30}>Mỗi 30 phút</option>
                            <option value={60}>Mỗi 1 giờ</option>
                            <option value={120}>Mỗi 2 giờ</option>
                            <option value={240}>Mỗi 4 giờ</option>
                            <option value={480}>Mỗi 8 giờ</option>
                            <option value={720}>Mỗi 12 giờ</option>
                            <option value={1440}>Mỗi 24 giờ</option>
                          </select>
                        </div>
                      )}
                      {selectedCampaign.schedule_mode === "fixed_times" && (
                        <div>
                          <input
                            type="text"
                            key={selectedCampaign.id + "-fixed"}
                            defaultValue={(selectedCampaign.schedule_fixed_times || []).join(", ")}
                            placeholder="Ví dụ: 08:00, 12:00, 18:00"
                            onBlur={async (e) => {
                              const times = e.target.value.split(/[,;\s]+/).map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
                              if (times.length === 0) return;
                              await updateRepeatSchedule({ schedule_fixed_times: times });
                            }}
                            className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-semibold text-gray-900 focus:bg-white focus:outline-none"
                          />
                          <span className="text-[10px] text-gray-400 font-medium mt-1 block">Giờ theo múi giờ Việt Nam (GMT+7). Cách nhau bằng dấu phẩy.</span>
                        </div>
                      )}
                      {selectedCampaign.next_run_at && (
                        <p className="text-[10px] font-bold text-indigo-500">
                          Lần chạy kế tiếp: {formatVietnamDateTime(selectedCampaign.next_run_at)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                  <select
                    value={selectedCampaign.repeat_enabled ? String(selectedCampaign.repeat_interval_minutes || 60) : "off"}
                    onChange={(e) => {
                      if (e.target.value === "off") {
                        updateRepeatSchedule({ repeat_enabled: false });
                        return;
                      }
                      updateRepeatSchedule({
                        repeat_enabled: true,
                        repeat_interval_minutes: Number(e.target.value)
                      });
                    }}
                    className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                  >
                    <option value="off">Không tự chạy lại</option>
                    <option value={5}>Mỗi 5 phút</option>
                    <option value={15}>Mỗi 15 phút</option>
                    <option value={30}>Mỗi 30 phút</option>
                    <option value={60}>Mỗi 1 giờ</option>
                    <option value={360}>Mỗi 6 giờ</option>
                    <option value={1440}>Mỗi ngày</option>
                  </select>
                  {selectedCampaign.repeat_enabled && (
                    <p className="text-[10px] font-bold text-gray-400">
                      Lần chạy kế tiếp: {selectedCampaign.next_run_at ? formatVietnamDateTime(selectedCampaign.next_run_at) : "sau khi vòng hiện tại hoàn tất"}
                    </p>
                  )}
                    </>
                  )}
                </div>
              )}

            {selectedCampaign.platform === "Facebook" && (
              <div className="bg-white border border-gray-200 p-5 rounded-md text-xs font-bold text-gray-600 space-y-3 shadow-none">
                <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500 border-b pb-2">Ảnh bài viết (khi bài chưa có ảnh riêng)</h4>
                <div>
                  <label className="block mb-1.5 text-[10px] font-extrabold text-gray-500 uppercase tracking-wide">Chế độ lấy ảnh</label>
                  <select
                    value={selectedCampaign.post_image_mode || "UPLOAD"}
                    onChange={(e) => updateCampaignImageSettings({ post_image_mode: e.target.value })}
                    className="w-full h-10 bg-gray-55 border border-gray-200 rounded px-3 text-xs font-bold text-gray-900 focus:bg-white focus:outline-none cursor-pointer"
                  >
                    <option value="UPLOAD">Tải ảnh lên riêng cho từng bài (như hiện tại)</option>
                    <option value="FROM_POST">Lấy ngẫu nhiên ảnh từ link trong nội dung comment</option>
                    <option value="AI_GENERATED">AI tự sinh ảnh theo prompt</option>
                  </select>
                </div>

                {(!selectedCampaign.post_image_mode || selectedCampaign.post_image_mode === "UPLOAD") && (
                  <p className="text-[10px] text-gray-400 font-medium leading-relaxed">
                    Dùng ảnh tải lên riêng cho từng bài ở mục "Danh sách bài đăng" bên dưới (nút 📷 Tải ảnh lên trên mỗi bài).
                  </p>
                )}

                {selectedCampaign.post_image_mode === "FROM_POST" && (
                  <p className="text-[10px] text-gray-400 font-medium leading-relaxed">
                    Với các bài chưa tự tải ảnh riêng: nếu nội dung &quot;Comment đầu tiên&quot; của bài đó có chứa 1 link (Facebook hoặc trang bất kỳ, ví dụ link bài báo), hệ thống sẽ mở link đó và tự lấy ngẫu nhiên 1 ảnh để đính kèm vào BÀI VIẾT (không phải comment). Nếu link là Facebook, cần cookie Facebook ở tài khoản (mục Tài khoản mạng xã hội) để xem được ảnh. Nếu không có link, bài đăng không kèm ảnh.
                  </p>
                )}

                {selectedCampaign.post_image_mode === "AI_GENERATED" && (
                  <div>
                    <textarea
                      key={selectedCampaign.id + "-pimg-prompt"}
                      defaultValue={selectedCampaign.post_image_prompt || ""}
                      placeholder="Ví dụ: ảnh sản phẩm mỹ phẩm phong cách minimal, ánh sáng tự nhiên"
                      rows={3}
                      onBlur={(e) => updateCampaignImageSettings({ post_image_prompt: e.target.value.trim() || null })}
                      className="w-full bg-gray-55 border border-gray-200 rounded px-3 py-2 text-xs font-semibold text-gray-900 focus:bg-white focus:outline-none resize-none"
                    />
                    <span className="text-[10px] text-gray-400 font-medium mt-1 block">Với các bài chưa tự tải ảnh riêng, AI sẽ sinh 1 ảnh mới cho bài viết dựa trên prompt này.</span>
                  </div>
                )}
              </div>
            )}

            {/* Split Section: Imports */}
            <div className={`grid grid-cols-1 gap-8 ${selectedCampaign.platform !== "Facebook" ? "md:grid-cols-2" : ""}`}>

              {/* Col 1: URLs (hidden for Facebook) */}
              {selectedCampaign.platform !== "Facebook" && <div className="space-y-4">
                <div className="flex justify-between items-center px-1">
                  <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500">Đường dẫn bài viết (URLs)</h4>
                  <span className="text-[10px] text-gray-500 font-bold">
                    Hoàn thành {completedUrlCount} / {campaignUrls.length}
                  </span>
                </div>

                {selectedCampaign.campaign_type === "MONITOR" ? (
                  <div className="bg-blue-50 border border-blue-200 text-blue-800 p-4 rounded-md text-xs font-bold shadow-none">
                    <p className="flex items-center gap-1.5">📢 Chiến dịch tự động giám sát trang</p>
                    <p className="text-gray-500 font-semibold mt-1">Các bài đăng mới phát hiện sẽ tự động được quét và đưa vào danh sách xử lý dưới đây.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                      <textarea
                        value={bulkUrls}
                        onChange={(e) => setBulkUrls(e.target.value)}
                        placeholder={selectedCampaign.platform === "Facebook" ? "Nhập danh sách link bài viết Facebook (mỗi dòng một link, ví dụ: https://www.facebook.com/page/posts/123456)" : "Nhập danh sách bài viết (mỗi dòng một đường dẫn bài đăng, ví dụ: https://x.com/user/status/123)"}
                        rows={3}
                        className="w-full bg-white border border-gray-200 rounded-md p-3.5 text-xs font-medium text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all resize-none"
                      />
                      {bulkUrls.trim() && (
                        <div className={`rounded-md border px-3 py-2 text-[11px] font-bold ${
                          parsedBulkUrls.length > 0
                            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                            : "bg-amber-50 border-amber-200 text-amber-700"
                        }`}>
                          Đã nhận {parsedBulkUrls.length} URL hợp lệ cho {selectedCampaign.platform}.
                        </div>
                      )}
                      <button
                        onClick={handleImportUrls}
                        disabled={Boolean(bulkUrls.trim()) && parsedBulkUrls.length === 0}
                        className="w-full h-11 bg-white hover:bg-gray-50 border border-gray-200 text-[#3B82F6] font-extrabold rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                      >
                        📥 Nhập danh sách bài đăng
                      </button>
                  </div>
                )}

                <div className="bg-white border border-gray-200 rounded-md p-4 max-h-80 overflow-y-auto space-y-2 shadow-none">
                  {campaignUrls.length === 0 ? (
                    <p className="text-center text-gray-400 text-xs font-bold py-6">Chưa có bài đăng nào được nhập.</p>
                  ) : (
                    <>
                      {/* Assign All Accounts Dropdown */}
                      {platformAccounts.length > 0 && (selectedCampaign.status === "DRAFT" || selectedCampaign.status === "READY" || selectedCampaign.status === "PAUSED") && (
                        <div className="flex items-center gap-2 p-3 bg-blue-50 rounded border border-blue-200 mb-3">
                          <span className="text-[11px] font-extrabold text-blue-700 whitespace-nowrap">Gán tất cả:</span>
                          <select
                            onChange={(e) => assignAccountToAll(e.target.value)}
                            className="flex-1 h-8 bg-white border border-blue-200 rounded px-2 text-[11px] font-bold text-gray-900 focus:border-blue-400 focus:outline-none cursor-pointer"
                            defaultValue=""
                          >
                            <option value="">— Bỏ gán tất cả —</option>
                            {platformAccounts.map((acc) => (
                              <option key={acc.id} value={acc.id}>
                                @{acc.username} {acc.status !== "ACTIVE" ? `(${acc.status})` : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {campaignUrls.map((url) => {
                        const jobsForUrl = getJobsForUrl(url);
                        const job = jobsForUrl[jobsForUrl.length - 1];
                        const successJobs = jobsForUrl.filter((item) => item.status === "SUCCESS");
                        const status = getStatusForUrlJobs(jobsForUrl, url.status);
                        const isEditable = selectedCampaign.status === "DRAFT" || selectedCampaign.status === "READY" || selectedCampaign.status === "PAUSED";
                        const accountLabel = job?.account_username 
                          ? `@${job.account_username}` 
                          : url.assigned_account_username
                          ? `@${url.assigned_account_username}`
                          : (selectedCampaign.status === "DRAFT" || selectedCampaign.status === "READY")
                          ? "Tự động gán (round-robin)"
                          : "Chưa gán tài khoản";

                        return (
                          <div key={url.id} className="p-3 bg-gray-50 rounded border border-gray-200 text-[11px] shadow-none space-y-2">
                            <div className="flex justify-between items-start gap-3">
                              <a
                                href={url.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex-1 truncate text-[#3B82F6] hover:text-blue-700 hover:underline font-mono font-extrabold"
                                title={url.url}
                              >
                                {url.url}
                              </a>
                              <span className={`shrink-0 px-2 py-0.5 rounded text-[9px] font-extrabold uppercase ${
                                status === "SUCCESS"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  : status === "FAILED"
                                  ? "bg-red-50 text-red-700 border border-red-200"
                                  : status === "RUNNING" || status === "PROCESSING"
                                  ? "bg-blue-50 text-blue-700 border border-blue-200 animate-pulse"
                                  : status === "QUEUED" || status === "RETRYING"
                                  ? "bg-amber-50 text-amber-700 border border-amber-200"
                                  : "bg-gray-100 text-gray-600 border border-gray-200"
                              }`}>
                                {getJobStatusText(status)}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-2 text-[10px]">
                              {url.monitor_source_url && (
                                <span className="w-full truncate font-bold text-gray-500">
                                  Nguồn giám sát: <a href={url.monitor_source_url} target="_blank" rel="noopener noreferrer" className="text-[#3B82F6] hover:underline font-mono">{url.monitor_source_url}</a>
                                </span>
                              )}
                              {isEditable && platformAccounts.length > 0 ? (
                                <div className="flex items-center gap-1.5">
                                  <span className="font-extrabold text-gray-700 whitespace-nowrap">Người xử lý:</span>
                                  <select
                                    value={url.assigned_account_id || ""}
                                    onChange={(e) => assignAccountToUrl(url.id, e.target.value)}
                                    className={`h-7 border rounded px-1.5 text-[10px] font-bold cursor-pointer focus:outline-none focus:border-blue-400 transition-all ${
                                      url.assigned_account_id
                                        ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                                        : "bg-white border-gray-200 text-gray-600"
                                    }`}
                                  >
                                    <option value="">🔄 Tự động (round-robin)</option>
                                    {platformAccounts.map((acc) => (
                                      <option key={acc.id} value={acc.id}>
                                        @{acc.username} {acc.status !== "ACTIVE" ? `(${acc.status})` : ""}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              ) : (
                                <span className="font-extrabold text-gray-700">
                                  Người xử lý: <span className="text-gray-900">{accountLabel}</span>
                                </span>
                              )}
                              {job?.real_api && (
                                <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-extrabold uppercase text-emerald-700">
                                  Cookie thật
                                </span>
                              )}
                              {job ? (
                                <span className="font-bold text-gray-500">
                                  Tác vụ {successJobs.length}/{jobsForUrl.length} - Thử {job.attempt_count}/3
                                </span>
                              ) : (
                                <span className="font-bold text-gray-400">Job sẽ tạo khi chạy campaign</span>
                              )}
                            </div>

                            {successJobs.length > 0 && (
                              <div className="mt-1.5 bg-white border border-gray-100 rounded p-2 text-gray-700 font-semibold shadow-none text-[10px] space-y-1">
                                <span className="font-extrabold text-gray-400 block text-[9px] uppercase tracking-wider mb-0.5">Nội dung đã comment:</span>
                                {successJobs.map((item, index) => (
                                  <div
                                    key={item.id || `${url.id}-${index}`}
                                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2"
                                    title={`${item.commented_text || item.template_content || ""}${item.completed_at ? ` - ${formatVietnamDateTime(item.completed_at)}` : ""}`}
                                  >
                                    <span className="truncate">
                                      {index + 1}. "{item.commented_text || item.template_content}"
                                    </span>
                                    {item.completed_at && (
                                      <span className="shrink-0 font-mono text-[9px] font-extrabold text-gray-400">
                                        {formatVietnamDateTime(item.completed_at)}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}

                            {jobsForUrl.filter((item) => item.error_message).map((item, index) => (
                              <p key={`${item.id || url.id}-err-${index}`} className="text-[10px] font-mono text-red-600 truncate mt-1" title={item.error_message}>
                                Lỗi: {item.error_message}
                              </p>
                            ))}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>}

              {/* Col 2: Comment Templates / Post Content */}
              <div className="space-y-4">
                <div className="flex justify-between items-center px-1">
                  <h4 className="text-xs font-extrabold uppercase tracking-widest text-gray-500">
                    {selectedCampaign.platform === "Facebook" ? "Danh sách bài đăng" : "Mẫu nội dung bình luận"}
                  </h4>
                  <span className="text-[10px] text-gray-500 font-bold">Đã tải {campaignTemplates.length}</span>
                </div>

                {selectedCampaign.platform === "Facebook" ? (
                  /* ── Facebook card-based post list ── */
                  <div className="space-y-3">

                    {campaignTemplates.length === 0 && !showAddFbPost && (
                      <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-400 text-xs font-bold">
                        Chưa có bài đăng nào. Nhấn nút bên dưới để thêm.
                      </div>
                    )}

                    <div className="space-y-3 max-h-[640px] overflow-y-auto pr-1">
                      {campaignTemplates.map((tpl, idx) => {
                        if (tpl.published_at) {
                          return (
                            <div key={tpl.id} className="bg-gray-50 border border-gray-200 rounded-lg p-4 opacity-65">
                              <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                  <span className="bg-emerald-100 text-emerald-700 text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full border border-emerald-200">✓ Đã đăng</span>
                                  <span className="text-[10px] font-mono text-gray-400">{formatVietnamDateTime(tpl.published_at)}</span>
                                </div>
                                <button onClick={() => deleteFbTemplate(tpl.id)} className="text-[10px] font-bold text-gray-400 hover:text-red-500 transition-colors cursor-pointer">Xóa</button>
                              </div>
                              <div className={`grid gap-3 ${tpl.image_url ? "grid-cols-1 sm:grid-cols-[1fr_130px]" : "grid-cols-1"}`}>
                                <p className="text-xs text-gray-600 whitespace-pre-wrap break-words leading-relaxed">{tpl.content}</p>
                                {tpl.image_url && <img src={tpl.image_url} alt="" className="w-full h-20 object-cover rounded-lg border border-gray-200" onError={e => (e.currentTarget.style.display="none")} />}
                              </div>
                              {tpl.first_comment && (
                                <div className="mt-3 pl-3 border-l-2 border-indigo-200">
                                  <p className="text-[10px] font-extrabold text-indigo-500 uppercase tracking-wide mb-0.5">
                                    💬 Comment · {tpl.comment_delay_minutes > 0 ? `sau ${tpl.comment_delay_minutes} phút` : "ngay lập tức"}
                                  </p>
                                  <p className="text-[11px] text-indigo-700 font-medium leading-relaxed">{tpl.first_comment}</p>
                                </div>
                              )}
                            </div>
                          );
                        }
                        return (
                          <div key={tpl.id} className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-extrabold text-gray-400 uppercase tracking-widest">Bài #{idx + 1}</span>
                              <button onClick={() => deleteFbTemplate(tpl.id)} className="text-[10px] font-bold text-gray-400 hover:text-red-500 transition-colors cursor-pointer">✕ Xóa</button>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px] gap-3">
                              <textarea
                                key={`content-${tpl.id}`}
                                defaultValue={tpl.content}
                                rows={4}
                                onBlur={(e) => { if (e.target.value.trim() !== tpl.content) updateFbTemplate(tpl.id, { content: e.target.value.trim() }); }}
                                placeholder="Nội dung bài đăng Facebook..."
                                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-xs font-medium text-gray-900 focus:bg-white focus:border-blue-300 focus:outline-none resize-none leading-relaxed"
                              />
                              <div className="space-y-1.5">
                                {tpl.image_url && <img src={tpl.image_url} alt="" className="w-full h-20 object-cover rounded-lg border border-gray-200" onError={e => (e.currentTarget.style.display="none")} />}
                                <input
                                  key={`img-${tpl.id}`}
                                  type="text"
                                  defaultValue={tpl.image_url || ""}
                                  onBlur={(e) => { if ((e.target.value.trim() || null) !== (tpl.image_url || null)) updateFbTemplate(tpl.id, { image_url: e.target.value.trim() || null }); }}
                                  placeholder="URL ảnh..."
                                  className="w-full h-8 bg-gray-50 border border-gray-200 rounded-lg px-2 text-[10px] font-medium text-gray-900 focus:bg-white focus:outline-none"
                                />
                                <label className="cursor-pointer block">
                                  <span className="flex items-center justify-center h-7 w-full bg-gray-100 hover:bg-gray-200 border border-dashed border-gray-300 rounded-lg text-[10px] text-gray-500 font-bold transition-colors select-none">
                                    📷 Tải ảnh lên
                                  </span>
                                  <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    const url = await uploadImage(file);
                                    if (url) updateFbTemplate(tpl.id, { image_url: url });
                                    e.target.value = "";
                                  }} />
                                </label>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_110px] gap-3 items-start pt-2.5 border-t border-gray-100">
                              <div>
                                <label className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wide block mb-1.5">💬 Comment đính kèm</label>
                                <textarea
                                  key={`cmt-${tpl.id}`}
                                  defaultValue={tpl.first_comment || ""}
                                  rows={2}
                                  onBlur={(e) => { if ((e.target.value.trim() || null) !== (tpl.first_comment || null)) updateFbTemplate(tpl.id, { first_comment: e.target.value.trim() || null }); }}
                                  placeholder="Comment đăng kèm sau bài (tuỳ chọn)..."
                                  className="w-full bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 text-[11px] font-medium text-indigo-900 focus:bg-white focus:outline-none resize-none"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-extrabold text-gray-500 uppercase tracking-wide block mb-1.5">⏱ Delay</label>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    key={`delay-${tpl.id}`}
                                    type="number"
                                    min={0}
                                    defaultValue={tpl.comment_delay_minutes ?? 0}
                                    onBlur={(e) => { const v = Number(e.target.value); if (v !== (tpl.comment_delay_minutes ?? 0)) updateFbTemplate(tpl.id, { comment_delay_minutes: v }); }}
                                    className="w-16 h-9 bg-gray-50 border border-gray-200 rounded-lg px-2 text-sm font-bold text-gray-900 focus:bg-white focus:outline-none text-center"
                                  />
                                  <span className="text-[10px] text-gray-500 font-bold">phút</span>
                                </div>
                                <p className="text-[9px] text-gray-400 mt-1">0 = đăng ngay</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Add new post form (card style) */}
                      {showAddFbPost && (
                        <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-extrabold text-blue-700 uppercase tracking-widest">+ Bài đăng mới</span>
                            <button onClick={() => { setShowAddFbPost(false); setNewFbPost(emptyFbPost); }} className="text-[10px] font-bold text-gray-400 hover:text-red-500 cursor-pointer">✕ Hủy</button>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px] gap-3">
                            <textarea
                              value={newFbPost.content}
                              onChange={(e) => setNewFbPost({ ...newFbPost, content: e.target.value })}
                              rows={4}
                              placeholder="Nội dung bài đăng Facebook..."
                              autoFocus
                              className="w-full bg-white border border-blue-300 rounded-lg px-3 py-2.5 text-xs font-medium text-gray-900 focus:outline-none resize-none leading-relaxed"
                            />
                            <div className="space-y-1.5">
                              {newFbPost.image_url && <img src={newFbPost.image_url} alt="" className="w-full h-20 object-cover rounded-lg border border-blue-200" onError={e => (e.currentTarget.style.display="none")} />}
                              <input
                                type="text"
                                value={newFbPost.image_url}
                                onChange={(e) => setNewFbPost({ ...newFbPost, image_url: e.target.value })}
                                placeholder="URL ảnh..."
                                className="w-full h-8 bg-white border border-blue-300 rounded-lg px-2 text-[10px] font-medium text-gray-900 focus:outline-none"
                              />
                              <label className="cursor-pointer block">
                                <span className="flex items-center justify-center h-7 w-full bg-blue-100 hover:bg-blue-200 border border-dashed border-blue-300 rounded-lg text-[10px] text-blue-600 font-bold transition-colors select-none">
                                  📷 Tải ảnh lên
                                </span>
                                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  const url = await uploadImage(file);
                                  if (url) setNewFbPost(prev => ({ ...prev, image_url: url }));
                                  e.target.value = "";
                                }} />
                              </label>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-[1fr_110px] gap-3 items-start pt-2.5 border-t border-blue-200">
                            <div>
                              <label className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wide block mb-1.5">💬 Comment đính kèm</label>
                              <textarea
                                value={newFbPost.first_comment}
                                onChange={(e) => setNewFbPost({ ...newFbPost, first_comment: e.target.value })}
                                rows={2}
                                placeholder="Comment đăng kèm sau bài (tuỳ chọn)..."
                                className="w-full bg-white border border-indigo-200 rounded-lg px-3 py-2 text-[11px] font-medium text-indigo-900 focus:outline-none resize-none"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-extrabold text-gray-500 uppercase tracking-wide block mb-1.5">⏱ Delay</label>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  value={newFbPost.comment_delay_minutes}
                                  onChange={(e) => setNewFbPost({ ...newFbPost, comment_delay_minutes: Number(e.target.value) })}
                                  className="w-16 h-9 bg-white border border-blue-300 rounded-lg px-2 text-sm font-bold text-gray-900 focus:outline-none text-center"
                                />
                                <span className="text-[10px] text-gray-500 font-bold">phút</span>
                              </div>
                              <p className="text-[9px] text-gray-400 mt-1">0 = đăng ngay</p>
                            </div>
                          </div>

                          <button
                            onClick={addFbTemplate}
                            className="w-full h-10 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-lg text-xs transition-all duration-200 cursor-pointer"
                          >
                            ✓ Lưu bài đăng
                          </button>
                        </div>
                      )}
                    </div>

                    {!showAddFbPost && (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setShowAddFbPost(true)}
                          className="h-10 bg-white hover:bg-indigo-50 border border-indigo-200 text-indigo-600 font-extrabold rounded-lg text-xs transition-all duration-200 cursor-pointer"
                        >
                          + Thêm bài đăng mới
                        </button>
                        <button
                          onClick={() => setShowCsvModal(true)}
                          className="h-10 bg-white hover:bg-emerald-50 border border-emerald-300 text-emerald-700 font-extrabold rounded-lg text-xs transition-all duration-200 cursor-pointer"
                        >
                          📂 Import CSV / Excel
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  /* ── X / Threads bulk template UI ── */
                  <>
                    <div className="space-y-2">
                      <textarea
                        value={bulkTemplates}
                        onChange={(e) => setBulkTemplates(e.target.value)}
                        placeholder="Nhập nội dung bình luận (mỗi dòng một nội dung bình luận khác nhau)"
                        rows={3}
                        className="w-full bg-white border border-gray-200 rounded-md p-3.5 text-xs font-medium text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all resize-none"
                      />
                      {bulkTemplates.trim() && (
                        <div className={`rounded-md border px-3 py-2 text-[11px] font-bold ${parsedBulkTemplates.length > 0 ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
                          Đã nhận {parsedBulkTemplates.length} mẫu bình luận.
                        </div>
                      )}
                      <button
                        onClick={handleImportTemplates}
                        disabled={Boolean(bulkTemplates.trim()) && parsedBulkTemplates.length === 0}
                        className="w-full h-11 bg-white hover:bg-gray-50 border border-gray-200 text-[#3B82F6] font-extrabold rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                      >
                        📥 Nhập danh sách nội dung
                      </button>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-md p-4 max-h-56 overflow-y-auto space-y-2 shadow-none">
                      {campaignTemplates.length === 0 ? (
                        <p className="text-center text-gray-400 text-xs font-bold py-6">Chưa có mẫu bình luận nào được nhập.</p>
                      ) : (
                        campaignTemplates.map((tpl, idx) => (
                          <div key={tpl.id} className="p-3 bg-gray-50 rounded border border-gray-200 text-[11px] text-gray-600 font-bold shadow-none">
                            <span className="text-gray-400 mr-1">#{idx + 1}</span> "{tpl.content}"
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}

                {/* Facebook: Job result log (failed & pending comments only — successes visible in cards above) */}
                {selectedCampaign.platform === "Facebook" && campaignJobs.filter(j => j.job_type === "fb_publish" && (j.status === "FAILED" || j.fb_comment_status === "PENDING" || j.fb_comment_status === "FAILED")).length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-gray-200">
                    <h5 className="text-[10px] font-extrabold uppercase tracking-widest text-gray-400 px-1">Thông báo & lỗi</h5>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {campaignJobs
                        .filter(j => j.job_type === "fb_publish" && (j.status === "FAILED" || j.fb_comment_status === "PENDING" || j.fb_comment_status === "FAILED"))
                        .sort((a, b) => new Date(b.completed_at || b.created_at || 0).getTime() - new Date(a.completed_at || a.created_at || 0).getTime())
                        .map((job) => (
                          <div key={job.id} className={`rounded-lg border px-3 py-2.5 text-[11px] font-bold ${job.status === "FAILED" ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
                            <div className="flex justify-between items-center gap-2">
                              <span className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded-full ${job.status === "FAILED" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                                {job.status === "FAILED" ? "✗ Đăng bài thất bại" : "⏳ Comment đang chờ"}
                              </span>
                              {job.completed_at && <span className="font-mono text-[9px] text-gray-400">{formatVietnamDateTime(job.completed_at)}</span>}
                            </div>
                            {job.error_message && <p className="mt-1.5 text-[10px] font-mono text-red-600">{job.error_message}</p>}
                            {job.fb_comment_status === "PENDING" && (
                              <p className="mt-1 text-[10px] text-amber-700">Comment sẽ đăng sau {job.fb_comment_delay_minutes} phút kể từ khi bài được đăng</p>
                            )}
                            {job.fb_comment_status === "FAILED" && (
                              <p className="mt-1 text-[10px] text-red-600">Lỗi comment: {job.fb_comment_error}</p>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>

            </div>

            {/* Campaign warnings / error retries */}
            {selectedCampaign.platform !== "Facebook" && campaignUrls.some(u => u.status === "FAILED") && (
              <div className="bg-red-50 border border-red-200 text-red-600 p-5 rounded-md text-xs font-bold flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-none">
                <div>
                  <p>⚠️ Chú ý: Một số tác vụ bình luận trong chiến dịch này đã gặp lỗi</p>
                  <p className="text-gray-500 text-[11px] font-semibold mt-1">Lỗi có thể xuất phát từ việc mất kết nối API mạng xã hội hoặc tài khoản bị giới hạn tần suất. Bạn có thể kích hoạt thử lại toàn bộ.</p>
                </div>
                <button
                  onClick={() => retryAllFailed(selectedCampaign.id)}
                  className="h-10 bg-red-600 hover:bg-red-700 text-white font-extrabold px-4 rounded-md text-[11px] transition-all duration-200 hover:scale-105 cursor-pointer shrink-0 shadow-none"
                >
                  Thử lại các tác vụ lỗi
                </button>
              </div>
            )}

          </div>
        ) : (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center text-gray-500 font-bold text-xs h-64 flex flex-col justify-center items-center shadow-none">
            <svg className="w-12 h-12 text-gray-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5M5 19v-2a2 2 0 002-2h2a2 2 0 002-2V5" />
            </svg>
            <span>Chọn một chiến dịch ở danh mục thư mục bên trái để cấu hình danh sách đường dẫn bài viết, nội dung bình luận và kích hoạt tiến trình chạy.</span>
          </div>
        )}
      </div>

      {/* CREATE MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 z-50 animate-fade-in overflow-y-auto">
          <div className="bg-white border border-gray-200 rounded-lg max-w-md w-full p-5 sm:p-8 space-y-5 shadow-none animate-slide-up">
            <div className="flex justify-between items-center border-b border-gray-200 pb-3">
              <h3 className="text-base font-extrabold text-gray-900 uppercase tracking-tight">Tạo chiến dịch mới</h3>
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="text-gray-400 hover:text-gray-900 font-bold text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={handleCreate} className="space-y-4 text-xs font-bold text-gray-600">
              <div>
                <label className="block mb-1.5 ml-0.5">Tên chiến dịch</label>
                <input
                  type="text"
                  value={newCampaignName}
                  onChange={(e) => setNewCampaignName(e.target.value)}
                  placeholder="Ví dụ: Chiến dịch quảng cáo Threads 2026"
                  minLength={3}
                  maxLength={100}
                  className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                  required
                />
              </div>
              
              <div>
                <label className="block mb-1.5 ml-0.5">Nền tảng mạng xã hội</label>
                <select
                  value={newCampaignPlatform}
                  onChange={(e) => setNewCampaignPlatform(e.target.value)}
                  className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                >
                  <option value="X">X (Twitter)</option>
                  <option value="Threads">Threads</option>
                  <option value="Facebook">Facebook Page</option>
                </select>
              </div>

              {newCampaignPlatform !== "Facebook" && (
              <div>
                <label className="block mb-1.5 ml-0.5">Loại chiến dịch</label>
                <select
                  value={newCampaignType}
                  onChange={(e) => setNewCampaignType(e.target.value)}
                  className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                >
                  <option value="STATIC">Thủ công (Nhập danh sách bài viết trực tiếp)</option>
                  <option value="MONITOR">Tự động (Giám sát trang và lấy bài viết mới nhất)</option>
                </select>
              </div>
              )}

              {newCampaignPlatform === "Facebook" && (
                <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 space-y-3">
                  <p className="text-[10px] font-extrabold uppercase text-indigo-600 tracking-wide">Cấu hình Facebook Page</p>
                  <div>
                    <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Chọn Facebook Page để đăng bài</label>
                    {fbAccounts.length === 0 ? (
                      <p className="text-xs text-amber-600 font-semibold py-2">Chưa có Facebook Page nào. Hãy thêm ở <strong>Tài khoản mạng xã hội</strong> với nền tảng Facebook.</p>
                    ) : (
                      <select
                        value={fbAccountId}
                        onChange={(e) => setFbAccountId(e.target.value)}
                        className="w-full h-11 bg-white border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                        required
                      >
                        <option value="">-- Chọn Page --</option>
                        {fbAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>{acc.display_name || acc.username}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Lịch đăng bài</label>
                    <select
                      value={fbScheduleMode}
                      onChange={(e) => setFbScheduleMode(e.target.value)}
                      className="w-full h-11 bg-white border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                    >
                      <option value="">Chạy một lần (không lặp lại)</option>
                      <option value="interval">Lặp theo khoảng thời gian (phút)</option>
                      <option value="fixed_times">Lặp theo giờ cố định trong ngày</option>
                    </select>
                  </div>
                  {fbScheduleMode === "interval" && (
                    <div>
                      <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Khoảng cách giữa các lần chạy</label>
                      <select
                        value={fbIntervalMinutes}
                        onChange={(e) => setFbIntervalMinutes(Number(e.target.value))}
                        className="w-full h-11 bg-white border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                      >
                        <option value={5}>Mỗi 5 phút</option>
                        <option value={10}>Mỗi 10 phút</option>
                        <option value={15}>Mỗi 15 phút</option>
                        <option value={30}>Mỗi 30 phút</option>
                        <option value={60}>Mỗi 1 giờ</option>
                        <option value={120}>Mỗi 2 giờ</option>
                        <option value={240}>Mỗi 4 giờ</option>
                        <option value={480}>Mỗi 8 giờ</option>
                        <option value={720}>Mỗi 12 giờ</option>
                        <option value={1440}>Mỗi 24 giờ</option>
                      </select>
                    </div>
                  )}
                  {fbScheduleMode === "fixed_times" && (
                    <div>
                      <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Danh sách giờ cố định trong ngày (HH:MM)</label>
                      <input
                        type="text"
                        value={fbFixedTimes}
                        onChange={(e) => setFbFixedTimes(e.target.value)}
                        placeholder="Ví dụ: 08:00, 12:00, 18:00, 22:00"
                        className="w-full h-11 bg-white border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                      />
                      <span className="text-[10px] text-gray-400 font-medium mt-1 block">Nhập giờ cách nhau bằng dấu phẩy. Giờ theo UTC.</span>
                    </div>
                  )}

                  <div className="pt-2 border-t border-indigo-200">
                    <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Ảnh bài viết (khi bài chưa có ảnh riêng)</label>
                    <select
                      value={fbPostImageMode}
                      onChange={(e) => setFbPostImageMode(e.target.value)}
                      className="w-full h-11 bg-white border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                    >
                      <option value="UPLOAD">Tải ảnh lên riêng cho từng bài (như hiện tại)</option>
                      <option value="FROM_POST">Lấy ngẫu nhiên ảnh từ link trong nội dung comment</option>
                      <option value="AI_GENERATED">AI tự sinh ảnh theo prompt</option>
                    </select>
                  </div>

                  {fbPostImageMode === "UPLOAD" && (
                    <p className="text-[10px] text-gray-400 font-medium leading-relaxed">
                      Sau khi tạo chiến dịch, tải ảnh riêng cho từng bài ở mục "Danh sách bài đăng" (nút 📷 Tải ảnh lên trên mỗi bài).
                    </p>
                  )}

                  {fbPostImageMode === "FROM_POST" && (
                    <p className="text-[10px] text-gray-400 font-medium leading-relaxed">
                      Với các bài chưa tự tải ảnh riêng: nếu nội dung &quot;Comment đầu tiên&quot; của bài đó có chứa 1 link (Facebook hoặc trang bất kỳ, ví dụ link bài báo), hệ thống sẽ mở link đó và tự lấy ngẫu nhiên 1 ảnh để đính kèm vào BÀI VIẾT (không phải comment). Nếu link là Facebook, cần cookie Facebook ở tài khoản (mục Tài khoản mạng xã hội) để xem được ảnh. Nếu không có link, bài đăng không kèm ảnh.
                    </p>
                  )}

                  {fbPostImageMode === "AI_GENERATED" && (
                    <div>
                      <label className="block mb-1.5 ml-0.5 text-xs font-bold text-gray-700">Prompt sinh ảnh chung cho chiến dịch</label>
                      <textarea
                        value={fbPostImagePrompt}
                        onChange={(e) => setFbPostImagePrompt(e.target.value)}
                        placeholder="Ví dụ: ảnh sản phẩm mỹ phẩm phong cách minimal, ánh sáng tự nhiên"
                        rows={3}
                        className="w-full bg-white border border-gray-200 rounded-md px-4 py-2 text-xs font-semibold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all resize-none"
                      />
                      <span className="text-[10px] text-gray-400 font-medium mt-1 block">Với các bài chưa tự tải ảnh riêng, AI sẽ sinh 1 ảnh mới cho bài viết dựa trên prompt này.</span>
                    </div>
                  )}
                </div>
              )}

              {newCampaignPlatform !== "Facebook" && newCampaignType === "MONITOR" && (
                <>
                  <div>
                    <label className="block mb-1.5 ml-0.5">Link trang cần giám sát (Profile/Page Links)</label>
                    <textarea
                      value={newMonitorPageUrl}
                      onChange={(e) => setNewMonitorPageUrl(e.target.value)}
                      placeholder={newCampaignPlatform === "X" ? "Mỗi dòng một link, ví dụ:\nhttps://x.com/elonmusk\nhttps://x.com/openai" : "Mỗi dòng một link, ví dụ:\nhttps://www.threads.net/@zuck\nhttps://www.threads.net/@bbc"}
                      rows={4}
                      className="w-full bg-gray-100 border border-gray-200 rounded-md p-3.5 text-xs font-semibold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all resize-none"
                      required
                    />
                    {newMonitorPageUrl.trim() && (
                      <p className={`mt-1.5 text-[10px] font-bold ${parsedNewMonitorPageUrls.length > 0 ? "text-emerald-600" : "text-amber-600"}`}>
                        Đã nhận {parsedNewMonitorPageUrls.length} link giám sát hợp lệ cho {newCampaignPlatform}.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block mb-1.5 ml-0.5">Tần suất kiểm tra</label>
                    <select
                      value={newMonitorInterval}
                      onChange={(e) => setNewMonitorInterval(Number(e.target.value))}
                      className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                    >
                      <option value={1}>1 phút (Để test nhanh)</option>
                      <option value={5}>5 phút</option>
                      <option value={15}>15 phút</option>
                      <option value={30}>30 phút</option>
                      <option value={60}>1 giờ</option>
                    </select>
                  </div>
                </>
              )}

              {newCampaignPlatform !== "Facebook" && newCampaignType === "STATIC" && (
                <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-3">
                  <label className="flex items-center gap-2 text-xs font-extrabold text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newRepeatEnabled}
                      onChange={(e) => setNewRepeatEnabled(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-[#3B82F6] cursor-pointer"
                    />
                    <span>Tự chạy lại chiến dịch theo chu kỳ</span>
                  </label>
                  {newRepeatEnabled && (
                    <select
                      value={newRepeatInterval}
                      onChange={(e) => setNewRepeatInterval(Number(e.target.value))}
                      className="w-full h-10 bg-white border border-gray-200 rounded-md px-3 text-xs font-bold text-gray-900 focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
                    >
                      <option value={5}>Mỗi 5 phút</option>
                      <option value={15}>Mỗi 15 phút</option>
                      <option value={30}>Mỗi 30 phút</option>
                      <option value={60}>Mỗi 1 giờ</option>
                      <option value={360}>Mỗi 6 giờ</option>
                      <option value={1440}>Mỗi ngày</option>
                    </select>
                  )}
                </div>
              )}

              <div>
                <label className="block mb-1.5 ml-0.5">Mô tả chiến dịch</label>
                <textarea
                  value={newCampaignDesc}
                  onChange={(e) => setNewCampaignDesc(e.target.value)}
                  placeholder="Mô tả mục tiêu chiến dịch..."
                  rows={3}
                  className="w-full bg-gray-100 border border-gray-200 rounded-md p-3.5 text-xs font-medium text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all resize-none"
                />
              </div>

              <button
                type="submit"
                className="w-full h-12 bg-[#3B82F6] hover:bg-blue-600 text-white font-extrabold rounded-md text-xs transition-all duration-200 hover:scale-105 cursor-pointer shadow-none"
              >
                Tạo chiến dịch
              </button>
            </form>
          </div>
        </div>
      )}

      {/* CSV / Excel import modal (Facebook only) */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4 my-4">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-extrabold text-gray-900">📂 Import danh sách bài đăng</h3>
              <button onClick={() => { setShowCsvModal(false); setCsvPreview([]); }} className="text-gray-400 hover:text-gray-600 font-extrabold text-lg leading-none cursor-pointer">✕</button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-[11px] text-blue-800 space-y-0.5">
              <p className="font-extrabold mb-1">Định dạng file (.csv / .xlsx / .xls):</p>
              <p><span className="font-bold">Cột A:</span> Nội dung bài đăng <span className="text-red-500 font-bold">(bắt buộc)</span></p>
              <p><span className="font-bold">Cột B:</span> URL ảnh (tuỳ chọn)</p>
              <p><span className="font-bold">Cột C:</span> Comment đính kèm (tuỳ chọn)</p>
              <p><span className="font-bold">Cột D:</span> Delay comment — số phút (tuỳ chọn, mặc định 0)</p>
              <p className="text-blue-500 pt-1">Hàng đầu tiên có thể là header (content / nội dung) hoặc dữ liệu — hệ thống tự nhận biết.</p>
            </div>

            {csvPreview.length === 0 ? (
              <label className="cursor-pointer block">
                <div className="border-2 border-dashed border-emerald-300 rounded-xl p-10 text-center hover:bg-emerald-50 transition-colors">
                  <p className="text-3xl mb-2">📂</p>
                  <p className="text-sm font-extrabold text-emerald-700">Chọn file CSV hoặc Excel</p>
                  <p className="text-xs text-gray-400 mt-1">Hỗ trợ .csv, .xlsx, .xls</p>
                </div>
                <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleCsvFileChange} />
              </label>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <p className="text-xs font-bold text-gray-700">
                    Xem trước: <span className="text-indigo-700 font-extrabold">{csvPreview.length} bài đăng</span>
                  </p>
                  <button onClick={() => setCsvPreview([])} className="text-[11px] text-gray-400 hover:text-red-500 font-bold cursor-pointer">Chọn lại</button>
                </div>

                <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                  {csvPreview.slice(0, 30).map((row, i) => (
                    <div key={i} className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-[11px] space-y-1">
                      <p className="font-bold text-gray-900 line-clamp-2">{row.content}</p>
                      {row.image_url && <p className="text-blue-600 truncate">🖼 {row.image_url}</p>}
                      {row.first_comment && <p className="text-indigo-600 line-clamp-1">💬 {row.first_comment}</p>}
                      {row.comment_delay_minutes > 0 && <p className="text-gray-500">⏱ {row.comment_delay_minutes} phút</p>}
                    </div>
                  ))}
                  {csvPreview.length > 30 && (
                    <p className="text-center text-xs text-gray-400 py-2">... và {csvPreview.length - 30} bài khác</p>
                  )}
                </div>

                <button
                  onClick={handleCsvBulkImport}
                  disabled={csvImporting}
                  className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-lg text-xs transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {csvImporting ? "Đang import..." : `✓ Import ${csvPreview.length} bài đăng`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getApiBase } from "../../../lib/apiBase";

const API_BASE = getApiBase();

interface UserInfo {
  id: string;
  username: string;
  created_at: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: "success" | "error" }>>([]);
  
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  useEffect(() => {
    fetchUserInfo();
  }, []);

  const fetchUserInfo = async () => {
    try {
      const token = sessionStorage.getItem("campaign_token");
      if (!token) {
        router.replace("/login");
        return;
      }

      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) throw new Error("Không thể lấy thông tin user");
      const data = await res.json();
      setUserInfo(data);
    } catch (err: any) {
      showToast(err.message || "Lỗi khi tải thông tin", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!oldPassword || !newPassword || !confirmPassword) {
      showToast("Vui lòng điền đầy đủ các trường", "error");
      return;
    }

    if (newPassword !== confirmPassword) {
      showToast("Mật khẩu mới không khớp", "error");
      return;
    }

    if (newPassword.length < 6) {
      showToast("Mật khẩu mới phải có ít nhất 6 ký tự", "error");
      return;
    }

    setChangingPassword(true);
    try {
      const token = sessionStorage.getItem("campaign_token");
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Không thể đổi mật khẩu");
      }

      showToast("✅ Đổi mật khẩu thành công!");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      showToast(err.message || "Lỗi đổi mật khẩu", "error");
    } finally {
      setChangingPassword(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem("campaign_token");
    sessionStorage.removeItem("campaign_user");
    router.push("/login");
    showToast("✅ Đăng xuất thành công");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8 animate-slide-up">
      {/* Toasts */}
      <div className="fixed top-6 right-6 z-50 space-y-3">
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

      {/* User Profile Card */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg shadow-none p-6">
        <h2 className="text-xs font-extrabold text-gray-900 uppercase tracking-wider mb-5">Thông tin tài khoản</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Username</label>
            <input
              type="text"
              value={userInfo?.username || ""}
              readOnly
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900"
            />
          </div>

          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">User ID</label>
            <input
              type="text"
              value={userInfo?.id || ""}
              readOnly
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-mono text-gray-500"
            />
          </div>

          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Ngày tạo</label>
            <input
              type="text"
              value={userInfo?.created_at ? new Date(userInfo.created_at).toLocaleDateString("vi-VN") : ""}
              readOnly
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900"
            />
          </div>
        </div>
      </div>

      {/* Change Password Card */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg shadow-none p-6">
        <h2 className="text-xs font-extrabold text-gray-900 uppercase tracking-wider mb-5">Đổi mật khẩu</h2>

        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Mật khẩu cũ</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="Nhập mật khẩu hiện tại"
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
              disabled={changingPassword}
            />
          </div>

          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Mật khẩu mới</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Nhập mật khẩu mới (tối thiểu 6 ký tự)"
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
              disabled={changingPassword}
            />
          </div>

          <div>
            <label className="block text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Xác nhận mật khẩu mới</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Nhập lại mật khẩu mới"
              className="w-full h-11 bg-gray-100 border border-gray-200 rounded-md px-4 text-xs font-semibold text-gray-900 focus:bg-white focus:border-2 focus:border-[#3B82F6] focus:outline-none transition-all"
              disabled={changingPassword}
            />
          </div>

          <button
            type="submit"
            disabled={changingPassword}
            className="w-full h-11 bg-[#3B82F6] hover:bg-blue-600 text-white font-bold rounded-md text-xs transition-all duration-200 disabled:opacity-50 cursor-pointer"
          >
            {changingPassword ? "Đang xử lý..." : "Đổi mật khẩu"}
          </button>
        </form>
      </div>

      {/* Logout Card */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg shadow-none p-6">
        <h2 className="text-xs font-extrabold text-gray-900 uppercase tracking-wider mb-5">Đăng xuất</h2>
        <button
          onClick={handleLogout}
          className="w-full h-11 bg-white border border-red-200 text-red-600 hover:bg-red-50 font-bold rounded-md text-xs transition-all duration-200 cursor-pointer"
        >
          Đăng xuất ngay
        </button>
      </div>
    </div>
  );
}

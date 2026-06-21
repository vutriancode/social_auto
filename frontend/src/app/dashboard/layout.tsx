"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";

const MENU_ITEMS = [
  { id: "metrics", label: "Bảng điều khiển", href: "/dashboard", icon: "M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" },
  { id: "campaigns", label: "Quản lý chiến dịch", href: "/dashboard/campaigns", icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" },
  { id: "accounts", label: "Tài khoản mạng xã hội", href: "/dashboard/accounts", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" },
  { id: "jobs-manager", label: "Quản lý jobs", href: "/dashboard/jobs-manager", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
  { id: "settings", label: "Cài đặt tài khoản", href: "/dashboard/settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M12 15a3 3 0 100-6 3 3 0 000 6z" },
];

const HEADER_TITLES = {
  "/dashboard": "BẢNG ĐIỀU KHIỂN HỆ THỐNG",
  "/dashboard/campaigns": "QUẢN LÝ CHIẾN DỊCH BÌNH LUẬN",
  "/dashboard/accounts": "QUẢN LÝ TÀI KHOẢN MẠNG XÃ HỘI",
  "/dashboard/jobs-manager": "QUẢN LÝ JOBS",
  "/dashboard/settings": "CÀI ĐẶT TÀI KHOẢN NGƯỜI DÙNG",
};

export default function DashboardLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState(null);
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const storedToken = sessionStorage.getItem("campaign_token");
    const storedUser = sessionStorage.getItem("campaign_user");

    if (!storedToken) {
      router.replace("/login");
    } else {
      setToken(storedToken);
      setUsername(storedUser || "operator");
      setLoading(false);
    }
  }, [router]);

  // Close the mobile drawer whenever the route changes (e.g. after tapping a nav link)
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  const handleLogout = () => {
    sessionStorage.removeItem("campaign_token");
    sessionStorage.removeItem("campaign_user");
    router.replace("/login");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 bg-[#3B82F6] rounded-md animate-bounce" />
          <p className="font-bold text-lg text-gray-900 tracking-tight">Đang thiết lập kết nối an toàn...</p>
        </div>
      </div>
    );
  }

  const getHeaderTitle = () => {
    if (HEADER_TITLES[pathname]) return HEADER_TITLES[pathname];
    if (pathname.includes("/templates")) return "QUẢN LÝ TEMPLATES CHIẾN DỊCH";
    if (pathname.includes("/urls")) return "QUẢN LÝ TARGET URLS";
    return pathname.split("/").pop().toUpperCase();
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#FAFBFD] text-slate-800">

      {/* Mobile top bar (hamburger trigger) */}
      <div className="md:hidden flex items-center justify-between bg-gray-50 border border-gray-200 m-4 mb-0 p-4 rounded-lg shadow-none">
        <div className="flex items-center space-x-2.5">
          <div className="w-9 h-9 bg-[#3B82F6] rounded-lg flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          </div>
          <h2 className="font-extrabold text-slate-900 text-sm leading-none tracking-tight">Auto Social</h2>
        </div>
        <button
          onClick={() => setMobileMenuOpen(true)}
          aria-label="Mở menu điều hướng"
          className="p-2 rounded-md text-slate-500 hover:bg-slate-100 cursor-pointer"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {/* Mobile drawer backdrop */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          className="md:hidden fixed inset-0 bg-gray-900/40 backdrop-blur-sm z-40 animate-fade-in"
        />
      )}

      {/* Flat Sidebar Shell — slides in as a drawer on mobile, static on md+ */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-gray-50 border border-gray-200 p-6 flex flex-col justify-between shrink-0 h-[calc(100vh-32px)] m-4 rounded-lg shadow-none transition-transform duration-200 ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-[120%]"
        } md:translate-x-0`}
      >
        <div className="space-y-10">

          {/* Logo */}
          <div className="flex items-center justify-between pl-1">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-[#3B82F6] rounded-xl flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                </svg>
              </div>
              <div>
                <h2 className="font-extrabold text-slate-900 text-base leading-none tracking-tight">Auto Social</h2>
              </div>
            </div>
            <button
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Đóng menu"
              className="md:hidden p-1.5 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1.5">
            {MENU_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-xs font-bold tracking-wide transition-all duration-200 cursor-pointer ${
                    isActive
                      ? "bg-[#3B82F6] text-white"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  }`}
                >
                  <svg className={`w-5 h-5 shrink-0 ${isActive ? "text-white" : "text-slate-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} />
                  </svg>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Footer profile & logout */}
        <div className="border-t border-slate-100 pt-5 flex flex-col space-y-4">
          <div className="flex items-center space-x-3 px-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center font-extrabold text-slate-700 uppercase text-xs border border-slate-200/50">
              {username ? username.substring(0, 2) : "OP"}
            </div>
            <div className="truncate">
              <p className="text-slate-900 text-xs font-bold truncate">@{username}</p>
              <p className="text-[10px] text-slate-400 font-extrabold truncate uppercase tracking-wider mt-0.5">
                Tài khoản hệ thống
              </p>
            </div>
          </div>
          <button 
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 bg-slate-100 hover:bg-red-50 text-slate-600 hover:text-red-600 py-3 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer border border-transparent hover:border-red-100"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Đăng xuất hệ thống</span>
          </button>
        </div>
      </aside>

      {/* Main Layout Area */}
      <main className="flex-1 p-4 md:p-6 overflow-y-auto flex flex-col h-screen">
        {/* Flat Header block */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-gray-50 border border-gray-200 p-6 rounded-lg shadow-none mb-8">
          <div>
            <h1 className="text-lg font-extrabold text-slate-900 tracking-tight uppercase">
              {getHeaderTitle()}
            </h1>
            <p className="text-slate-450 text-[11px] font-semibold mt-1">Điều phối chiến dịch bình luận tự động</p>
          </div>
        </header>

        {/* Dynamic page contents wrapper */}
        <div className="flex-1 min-h-0">
          {children}
        </div>
      </main>

    </div>
  );
}

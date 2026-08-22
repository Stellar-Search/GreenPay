import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { adminLogin, getApiErrorMessage } from "@/lib/api";

export default function AdminLogin() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setState("loading");
    setError(null);
    try {
      await adminLogin(username, password);
      router.push("/admin");
    } catch (e: unknown) {
      setError(getApiErrorMessage(e, "Invalid credentials"));
      setState("error");
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-16">
      <div className="card">
        <h1 className="font-display text-2xl font-bold text-forest-900 mb-1">Admin Login</h1>
        <p className="text-sm text-[#4b654b] font-body mb-6">
          Sign in with platform-admin credentials to review project submissions.
        </p>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="admin-username"
              className="block text-xs font-bold text-forest-800 uppercase tracking-widest mb-1 ms-1 opacity-50"
            >
              Username
            </label>
            <input
              id="admin-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input-field"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label
              htmlFor="admin-password"
              className="block text-xs font-bold text-forest-800 uppercase tracking-widest mb-1 ms-1 opacity-50"
            >
              Password
            </label>
            <input
              id="admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={state === "loading"}
            className="btn-primary w-full disabled:opacity-50"
          >
            {state === "loading" ? "Signing in…" : "Log In"}
          </button>
        </form>
      </div>
    </div>
  );
}

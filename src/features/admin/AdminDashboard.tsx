import React, { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, RefreshCcw, Users, Zap, DollarSign, ImageIcon, Mail, TrendingUp } from 'lucide-react';
import { auth, onAuthStateChanged, loginWithGoogle, FirebaseUser } from '../../lib/firebase';
import GroupedBarChart, { CHART_COLORS } from './GroupedBarChart';

interface DashboardData {
  windowDays: number;
  overview: {
    totalUsers: number;
    newUsersWindow: number;
    activeUsersWindow: number;
    generationsToday: number;
    generationsWindow: number;
    successRateWindow: number | null;
    estimatedCostWindowUsd: number;
    portraitAttachRateWindow: number | null;
    pendingCreditRequests: number;
  };
  trend: {
    days: string[];
    analyzeSuccess: number[];
    analyzeRejected: number[];
    analyzeError: number[];
    imageSuccess: number[];
    imageError: number[];
    analyzeCostUsd: number[];
    imageCostUsd: number[];
    analyzeTokens: number[];
    imageTokens: number[];
  };
  reliability: {
    analyzeSuccess: number; analyzeRejected: number; analyzeError: number; analyzeAttempts: number;
    imageSuccess: number; imageError: number; imageAttempts: number;
  };
  creditRequests: Array<{
    id: string; email: string; userId: string; requestedQuantity: number; status: string; createdAt: string;
  }>;
}

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(5)}`;
}

function formatPercent(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function StatTile({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[#111622] border border-[#1e293b] rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-zinc-500">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[10px] font-black uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-black text-white leading-none">{value}</div>
      {sub && <div className="text-[10.5px] text-zinc-500 font-semibold">{sub}</div>}
    </div>
  );
}

function ReliabilityPill({ status, label, count }: { status: 'good' | 'warning' | 'critical'; label: string; count: number }) {
  const color = status === 'good' ? CHART_COLORS.good : status === 'warning' ? CHART_COLORS.warning : CHART_COLORS.critical;
  return (
    <div className="flex items-center gap-2.5 bg-[#0c111d] border border-[#1e293b] rounded-xl px-3.5 py-2.5">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="ml-auto text-sm font-black text-white font-mono">{count.toLocaleString()}</span>
    </div>
  );
}

export default function AdminDashboard() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'forbidden' | 'error' | 'loaded'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [days, setDays] = useState(14);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const loadDashboard = async () => {
    if (!user) return;
    setStatus('loading');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/admin/dashboard?days=${days}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const json = await res.json();
      if (res.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (!res.ok) {
        setErrorMsg(json.error || 'Failed to load dashboard.');
        setStatus('error');
        return;
      }
      setData(json);
      setStatus('loaded');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Network error.');
      setStatus('error');
    }
  };

  useEffect(() => {
    if (user) loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, days]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#ff821c]" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center p-6">
        <div className="max-w-sm w-full bg-[#0c111a] border border-[#1e293b] rounded-3xl p-8 text-center space-y-5">
          <ShieldAlert className="w-10 h-10 text-[#ff821c] mx-auto" />
          <h1 className="text-lg font-black text-white uppercase">Admin Access</h1>
          <p className="text-xs text-zinc-400 font-semibold">Sign in with a Google account on the admin allowlist to view the dashboard.</p>
          <button
            onClick={() => loginWithGoogle().catch(() => {})}
            className="w-full bg-white text-black font-black uppercase px-6 py-3 rounded-xl text-xs"
          >
            Log In with Google
          </button>
        </div>
      </div>
    );
  }

  if (status === 'forbidden') {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center p-6">
        <div className="max-w-sm w-full bg-[#0c111a] border border-[#1e293b] rounded-3xl p-8 text-center space-y-3">
          <ShieldAlert className="w-10 h-10 text-red-400 mx-auto" />
          <h1 className="text-lg font-black text-white uppercase">Not authorized</h1>
          <p className="text-xs text-zinc-400 font-semibold">{user.email} is not on the admin allowlist (ADMIN_EMAILS).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090d16] text-[#f1f5f9] font-sans">
      <header className="border-b border-[#1e293b] bg-[#0c111d] px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 sticky top-0 z-10">
        <div>
          <h1 className="text-sm font-black uppercase tracking-tight text-white">Pawstories — Admin</h1>
          <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mt-0.5">{user.email}</p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-[10px] font-black uppercase px-3 py-1.5 rounded-lg transition-all ${days === d ? 'bg-[#ff821c] text-black' : 'bg-[#111622] text-zinc-400 border border-[#1e293b]'}`}
            >
              {d}d
            </button>
          ))}
          <button onClick={loadDashboard} className="p-2 bg-[#111622] border border-[#1e293b] rounded-lg text-zinc-400 hover:text-white">
            <RefreshCcw className={`w-3.5 h-3.5 ${status === 'loading' ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
        {status === 'error' && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-xs font-semibold p-4 rounded-xl">{errorMsg}</div>
        )}

        {status === 'loading' && !data && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-[#ff821c]" />
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile icon={Users} label="Total Users" value={data.overview.totalUsers.toLocaleString()} sub={`+${data.overview.newUsersWindow} in ${data.windowDays}d`} />
              <StatTile icon={TrendingUp} label={`Active Users (${data.windowDays}d)`} value={data.overview.activeUsersWindow.toLocaleString()} />
              <StatTile icon={Zap} label="Generations Today" value={data.overview.generationsToday.toLocaleString()} />
              <StatTile icon={Zap} label={`Generations (${data.windowDays}d)`} value={data.overview.generationsWindow.toLocaleString()} />
              <StatTile icon={ShieldAlert} label="Success Rate" value={formatPercent(data.overview.successRateWindow)} />
              <StatTile icon={DollarSign} label={`Est. Cost (${data.windowDays}d)`} value={formatUsd(data.overview.estimatedCostWindowUsd)} />
              <StatTile icon={ImageIcon} label="Portrait Attach Rate" value={formatPercent(data.overview.portraitAttachRateWindow)} sub="of dossiers that also got a portrait" />
              <StatTile icon={Mail} label="Pending Credit Requests" value={data.overview.pendingCreditRequests.toLocaleString()} />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-[#0c111a] border border-[#1e293b] rounded-2xl p-5">
                <h2 className="text-xs font-black uppercase text-white tracking-wide mb-1">Generations per day</h2>
                <p className="text-[10.5px] text-zinc-500 font-semibold mb-4">Completed dossiers vs. rejected/failed attempts</p>
                <GroupedBarChart
                  days={data.trend.days}
                  series={[
                    { name: 'Success', color: CHART_COLORS.good, values: data.trend.analyzeSuccess },
                    {
                      name: 'Not completed', color: CHART_COLORS.critical,
                      values: data.trend.analyzeRejected.map((v, i) => v + data.trend.analyzeError[i]),
                    },
                  ]}
                />
              </div>
              <div className="bg-[#0c111a] border border-[#1e293b] rounded-2xl p-5">
                <h2 className="text-xs font-black uppercase text-white tracking-wide mb-1">Estimated cost per day</h2>
                <p className="text-[10.5px] text-zinc-500 font-semibold mb-4">Analyze vs. portrait generation spend (USD)</p>
                <GroupedBarChart
                  days={data.trend.days}
                  formatValue={formatUsd}
                  series={[
                    { name: 'Analyze', color: CHART_COLORS.blue, values: data.trend.analyzeCostUsd },
                    { name: 'Image', color: CHART_COLORS.orange, values: data.trend.imageCostUsd },
                  ]}
                />
              </div>
            </div>

            <div className="bg-[#0c111a] border border-[#1e293b] rounded-2xl p-5">
              <h2 className="text-xs font-black uppercase text-white tracking-wide mb-4">Reliability ({data.windowDays}d)</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-[10px] font-black uppercase text-zinc-500 tracking-wider">Analyze ({data.reliability.analyzeAttempts.toLocaleString()} attempts)</p>
                  <ReliabilityPill status="good" label="Success" count={data.reliability.analyzeSuccess} />
                  <ReliabilityPill status="warning" label="Rejected (human/invalid photo)" count={data.reliability.analyzeRejected} />
                  <ReliabilityPill status="critical" label="Error" count={data.reliability.analyzeError} />
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] font-black uppercase text-zinc-500 tracking-wider">Portrait ({data.reliability.imageAttempts.toLocaleString()} attempts)</p>
                  <ReliabilityPill status="good" label="Success" count={data.reliability.imageSuccess} />
                  <ReliabilityPill status="critical" label="Error" count={data.reliability.imageError} />
                </div>
              </div>
            </div>

            <div className="bg-[#0c111a] border border-[#1e293b] rounded-2xl p-5">
              <h2 className="text-xs font-black uppercase text-white tracking-wide mb-4">Recent credit requests</h2>
              {data.creditRequests.length === 0 ? (
                <p className="text-xs text-zinc-500 font-semibold">No requests yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-black uppercase text-zinc-500 border-b border-[#1e293b]">
                        <th className="pb-2 pr-4">Email</th>
                        <th className="pb-2 pr-4">Requested</th>
                        <th className="pb-2 pr-4">Status</th>
                        <th className="pb-2">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.creditRequests.map((r) => (
                        <tr key={r.id} className="border-b border-[#1e293b]/60">
                          <td className="py-2.5 pr-4 text-zinc-300 font-semibold">{r.email}</td>
                          <td className="py-2.5 pr-4 text-white font-mono">{r.requestedQuantity}</td>
                          <td className="py-2.5 pr-4">
                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${r.status === 'pending' ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-700/40 text-zinc-400'}`}>
                              {r.status}
                            </span>
                          </td>
                          <td className="py-2.5 text-zinc-500 font-mono text-[11px]">{new Date(r.createdAt).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

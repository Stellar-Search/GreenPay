/**
 * components/DonationFeed.tsx
 * Recent donations for a project — live community feed with real-time SSE streaming.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { fetchProjectDonations } from "@/lib/api";
import { formatXLM, timeAgo, shortenAddress } from "@/utils/format";
import { explorerUrl, streamProjectPayments, type HorizonPagingToken } from "@/lib/stellar";
import { useDonationSocket } from "@/hooks/useDonationSocket";
import type { Donation } from "@/utils/types";

interface DonationFeedProps {
  projectId: string;
  walletAddress?: string;
  refreshKey?: number;
  onNewDonation?: (donation: Donation) => void;
}

const MAX_SEEN_HASHES = 500;

export default function DonationFeed({ projectId, walletAddress, refreshKey = 0, onNewDonation }: DonationFeedProps) {
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const latestPagingTokenRef = useRef<HorizonPagingToken | null>(null);
  const seenTxHashesRef = useRef<Set<string>>(new Set());

  // Hold onNewDonation in a ref so prop identity changes never restart the stream
  const onNewDonationRef = useRef(onNewDonation);
  useEffect(() => {
    onNewDonationRef.current = onNewDonation;
  }, [onNewDonation]);

  // Helper to safely add transaction hashes to the set with a maximum capacity bound
  const addSeenTxHash = useCallback((hash: string) => {
    if (seenTxHashesRef.current.size >= MAX_SEEN_HASHES) {
      const firstItem = seenTxHashesRef.current.values().next().value;
      if (firstItem) {
        seenTxHashesRef.current.delete(firstItem);
      }
    }
    seenTxHashesRef.current.add(hash);
  }, []);

  // Load initial donation data from the backend API. Note: `d.id` is a
  // backend database identifier, not a Horizon paging token, so it must
  // never seed the SSE cursor below.
  useEffect(() => {
    setLoading(true);
    fetchProjectDonations(projectId, 10)
      .then(({ donations: data, nextCursor: cursor }) => {
        setDonations(data);
        setNextCursor(cursor);
        data.forEach((d) => addSeenTxHash(d.transactionHash));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId, refreshKey, addSeenTxHash]);

  // Handle incoming SSE payment
  const handleNewPayment = useCallback((payment: {
    id: string;
    pagingToken: HorizonPagingToken;
    from: string;
    amount: string;
    asset: string;
    createdAt: string;
    transactionHash: string;
  }) => {
    if (seenTxHashesRef.current.has(payment.transactionHash)) return;
    addSeenTxHash(payment.transactionHash);

    const newDonation: Donation = {
      id: payment.id,
      projectId,
      donorAddress: payment.from,
      amountXLM: payment.amount,
      amount: payment.amount,
      currency: (payment.asset === "XLM" ? "XLM" : "USDC") as "XLM" | "USDC",
      transactionHash: payment.transactionHash,
      createdAt: payment.createdAt,
    };

    setDonations((prev) => {
      if (prev.some((d) => d.id === newDonation.id)) return prev;
      return [newDonation, ...prev];
    });

    setNewIds((prev) => new Set(prev).add(payment.id));
    setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        next.delete(payment.id);
        return next;
      });
    }, 2000);

    onNewDonationRef.current?.(newDonation);

    latestPagingTokenRef.current = payment.pagingToken;
  }, [projectId, addSeenTxHash]);

  // Handle incoming donation pushed over the Socket.io "donation_event" channel
  const handleSocketDonation = useCallback((payload: {
    donorAddress: string;
    amountXLM: number;
    transactionHash: string;
    timestamp: string;
  }) => {
    if (seenTxHashesRef.current.has(payload.transactionHash)) return;
    addSeenTxHash(payload.transactionHash);

    const newDonation: Donation = {
      id: payload.transactionHash,
      projectId,
      donorAddress: payload.donorAddress,
      amountXLM: String(payload.amountXLM),
      amount: String(payload.amountXLM),
      currency: "XLM",
      transactionHash: payload.transactionHash,
      createdAt: payload.timestamp,
    };

    setDonations((prev) => [newDonation, ...prev]);
    setNewIds((prev) => new Set(prev).add(newDonation.id));
    setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        next.delete(newDonation.id);
        return next;
      });
    }, 2000);

    onNewDonationRef.current?.(newDonation);
  }, [projectId, addSeenTxHash]);

  useDonationSocket(projectId, handleSocketDonation);

  // Start SSE stream once initial data is loaded
  // Keyed only on loading and walletAddress to avoid unnecessary reconnects
  useEffect(() => {
    if (loading || !walletAddress) return;

    setStreamDisconnected(false);
    const cursor = latestPagingTokenRef.current || undefined;
    const closeStream = streamProjectPayments(
      walletAddress,
      handleNewPayment,
      cursor,
      () => setStreamDisconnected(true),
    );

    return () => {
      closeStream();
    };
  }, [loading, walletAddress]); // handleNewPayment omitted intentionally

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { donations: newDonations, nextCursor: cursor } = await fetchProjectDonations(projectId, 10, nextCursor);
      setDonations(prev => [...prev, ...newDonations]);
      setNextCursor(cursor);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="animate-pulse flex gap-3 p-3 rounded-xl bg-forest-50">
          <div className="w-8 h-8 rounded-full bg-forest-200 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-forest-200 rounded w-1/2" />
            <div className="h-2 bg-forest-100 rounded w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );

  const renderStreamStatus = (connectedText: string, className: string) => walletAddress && (
    <div className={`flex items-center gap-2 text-xs font-body ${className} ${streamDisconnected ? "text-red-600" : "text-forest-500"}`}>
      <span className={`w-2 h-2 rounded-full ${streamDisconnected ? "bg-red-500" : "bg-emerald-500 animate-pulse"}`} />
      {streamDisconnected ? "Disconnected — live updates paused" : connectedText}
    </div>
  );

  if (donations.length === 0) return (
    <div>
      {renderStreamStatus("Listening for live donations…", "mb-3")}
      <p className="text-center text-[#4b654b] text-sm py-6 font-body">No donations yet — be the first! 🌱</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {renderStreamStatus("Live — new donations appear automatically", "mb-1")}
      {donations.map((d) => (
        <div
          key={d.id}
          className={`flex items-start gap-3 p-3 rounded-xl bg-forest-50 hover:bg-forest-100 transition-all duration-500 ${
            newIds.has(d.id)
              ? "animate-slide-in ring-2 ring-emerald-400/50 bg-emerald-50"
              : ""
          }`}
        >
          <div className="w-9 h-9 rounded-full bg-forest-200 flex items-center justify-center flex-shrink-0 text-base">
            {newIds.has(d.id) ? "✨" : "🌱"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-forest-900 text-sm font-body">{shortenAddress(d.donorAddress, 5)}</span>
              <span className="font-mono font-bold text-forest-600 text-sm">
                {d.currency === "USDC" ? `$${parseFloat(d.amount || "0").toFixed(2)} USDC` : formatXLM(d.amountXLM || d.amount || "0")}
              </span>
              {d.isMatched && (
                <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-body font-semibold">
                  Matched!
                </span>
              )}
              {newIds.has(d.id) && (
                <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-body font-semibold">
                  NEW
                </span>
              )}
            </div>
            {d.message && <p className="text-xs text-[#4b654b] mt-0.5 italic font-body">&quot;{d.message}&quot;</p>}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-[#547454] font-body">{timeAgo(d.createdAt)}</span>
              <a href={explorerUrl(d.transactionHash)} target="_blank" rel="noopener noreferrer"
                className="text-xs text-forest-500 hover:text-forest-700 transition-colors font-body">
                View tx ↗
              </a>
            </div>
          </div>
        </div>
      ))}
      {nextCursor && (
        <button
          onClick={handleLoadMore}
          disabled={loadingMore}
          className="w-full mt-4 px-4 py-2 bg-forest-100 hover:bg-forest-200 text-forest-700 rounded-lg transition-colors font-body text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingMore ? "Loading..." : "Load more donations"}
        </button>
      )}

      <style jsx>{`
        @keyframes slide-in {
          from {
            opacity: 0;
            transform: translateY(-12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        :global(.animate-slide-in) {
          animation: slide-in 0.4s ease-out;
        }
      `}</style>
    </div>
  );
}
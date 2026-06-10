import { NextRequest, NextResponse } from "next/server";

/**
 * ERC-4337 bundler proxy.
 *
 * Browser code POSTs JSON-RPC here; this route forwards to Pimlico (or whichever
 * vendor BUNDLER_BASE_URL points at) with the server-side API key attached.
 *
 * Method allowlist is intentionally tight — only the read/submit ops a paymaster
 * client needs. We do NOT proxy pm_* methods because we run our own
 * /api/paymaster route for that.
 *
 * SECURITY: This endpoint is unauthenticated. Anyone can submit UserOps and burn
 * the bundler quota. Acceptable for testnet bring-up; before production switch:
 *   - gate behind a SIWE session (already wired at /api/siwe), OR
 *   - put Vercel WAF / Cloudflare in front with rate limiting.
 */

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown[];
};

const ALLOWED_METHODS = new Set<string>([
  // Standard ERC-4337
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "eth_supportedEntryPoints",
  "eth_chainId",
  // Pimlico extensions (safe to expose; needed by permissionless.js's gas-price helper)
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
]);

function jsonRpcError(id: number | string | null, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ chainId: string }> }) {
  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) {
    return jsonRpcError(null, -32603, "Bundler not configured (PIMLICO_API_KEY missing)", 503);
  }

  const { chainId: chainIdRaw } = await params;
  const chainId = Number.parseInt(chainIdRaw, 10);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return jsonRpcError(null, -32602, `Invalid chainId: ${chainIdRaw}`, 400);
  }

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id ?? null, -32600, "Invalid JSON-RPC request", 400);
  }

  if (!ALLOWED_METHODS.has(body.method)) {
    return jsonRpcError(body.id ?? null, -32601, `Method not allowed: ${body.method}`);
  }

  const base = process.env.BUNDLER_BASE_URL ?? "https://api.pimlico.io";
  const url = `${base}/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Don't cache user-op submissions or status checks
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return jsonRpcError(body.id ?? null, -32603, `Bundler unreachable: ${msg}`, 502);
  }

  // Pass through the upstream JSON regardless of HTTP status — JSON-RPC errors live
  // in the response body and the caller (viem / permissionless) expects them there.
  const text = await upstream.text();
  try {
    const json = JSON.parse(text);
    return NextResponse.json(json);
  } catch {
    return jsonRpcError(body.id ?? null, -32603, `Bundler returned non-JSON: ${text.slice(0, 200)}`, 502);
  }
}

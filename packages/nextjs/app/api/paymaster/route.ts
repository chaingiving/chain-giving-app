import { NextRequest, NextResponse } from "next/server";
import { Address, Hex, isAddress } from "viem";
import deployedContracts from "~~/contracts/deployedContracts";

/**
 * ERC-7677 Paymaster Service for CGPaymaster (EntryPoint v0.7).
 *
 * Wallets supporting EIP-5792 `paymasterService` capability call this endpoint
 * with `pm_getPaymasterStubData` / `pm_getPaymasterData`. Our own Kernel-via-Pimlico
 * client (services/web3/smartAccount.ts) calls the same methods.
 *
 * Response shape is the EntryPoint v0.7 form (separate fields, not a packed blob).
 * The caller (wallet or bundler) assembles paymasterAndData itself:
 *   [0 :20] paymaster
 *   [20:36] paymasterVerificationGasLimit (uint128)
 *   [36:52] paymasterPostOpGasLimit       (uint128)
 *   [52: …] paymasterData  ← we return the sponsoring org address here (20 bytes)
 *
 * Params layout (ERC-7677):
 *   [0] userOp, [1] entryPoint, [2] chainId (hex), [3] context
 *
 * The sponsoring org address is passed via `context.orgAddress` from the frontend.
 */

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: unknown[];
};

// EntryPoint v0.7 canonical singleton. CGPaymaster is hardwired to this version;
// reject any caller that targets a different EntryPoint.
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032".toLowerCase();

// Gas headroom for paymaster validation/postOp. These end up in bytes 20..52 of
// paymasterAndData. Chosen to comfortably cover CGPaymaster's actual cost
// (~46k for validate, ~25-32k for postOp on observed runs) with margin for cold
// storage reads on the first sponsored UserOp per org.
const PAYMASTER_VERIFICATION_GAS_LIMIT: Hex = "0x10000"; // 65 536
const PAYMASTER_POST_OP_GAS_LIMIT: Hex = "0x8000"; //       32 768

function getPaymasterAddress(chainId: number): Address | undefined {
  const contracts = (deployedContracts as Record<number, any>)[chainId];
  return contracts?.CGPaymaster?.address as Address | undefined;
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const { jsonrpc, id, method, params } = body as JsonRpcRequest;

  if (jsonrpc !== "2.0" || id == null || typeof method !== "string" || !Array.isArray(params)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: (body as any)?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } },
      { status: 400 },
    );
  }

  // params[1] = entry point address; reject anything other than v0.7
  const entryPoint = params?.[1];
  if (typeof entryPoint !== "string" || entryPoint.toLowerCase() !== ENTRY_POINT_V07) {
    return jsonRpcError(id, -32602, `Unsupported EntryPoint: ${String(entryPoint)} (expected v0.7)`);
  }

  // params[2] = chainId (hex or decimal)
  const rawChainId = params?.[2];
  const chainId =
    typeof rawChainId === "string" ? parseInt(rawChainId, 16) : typeof rawChainId === "number" ? rawChainId : undefined;

  if (!chainId) {
    return jsonRpcError(id, -32602, "Missing or invalid chainId in params[2]");
  }

  const paymasterAddress = getPaymasterAddress(chainId);
  if (!paymasterAddress) {
    return jsonRpcError(id, -32602, `CGPaymaster not deployed on chain ${chainId}`);
  }

  const context = (params?.[3] as { orgAddress?: string } | undefined) ?? {};
  const orgAddress = context.orgAddress;

  if (!orgAddress || !isAddress(orgAddress)) {
    return jsonRpcError(id, -32602, "Missing or invalid context.orgAddress");
  }

  // For CGPaymaster, stub and final data are identical — validation is fully
  // on-chain and there is no signing service.
  if (method !== "pm_getPaymasterStubData" && method !== "pm_getPaymasterData") {
    return jsonRpcError(id, -32601, `Unknown method: ${method}`);
  }

  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result: {
      paymaster: paymasterAddress,
      paymasterData: orgAddress as Hex,
      paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
      paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
    },
  });
}

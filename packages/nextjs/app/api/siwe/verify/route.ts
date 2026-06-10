import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { type Chain, createPublicClient, getAddress, http } from "viem";
import { arcTestnet, baseSepolia, hardhat, mainnet, sepolia } from "viem/chains";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { assertSameOrigin } from "~~/utils/origin";
import { type SiweSessionData, getSessionOptions } from "~~/utils/siwe";

export const runtime = "nodejs";

const SUPPORTED_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
  [baseSepolia.id]: baseSepolia,
  [arcTestnet.id]: arcTestnet,
  [hardhat.id]: hardhat,
};

export async function POST(req: NextRequest) {
  const originErr = assertSameOrigin(req);
  if (originErr) return originErr;

  const session = await getIronSession<SiweSessionData>(await cookies(), getSessionOptions());

  let body: { message?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    return NextResponse.json({ error: "message and signature required" }, { status: 400 });
  }
  if (!signature.startsWith("0x")) {
    return NextResponse.json({ error: "signature must be 0x-prefixed" }, { status: 400 });
  }

  const storedNonce = session.nonce;
  if (!storedNonce) {
    return NextResponse.json({ error: "No nonce in session — request a fresh one" }, { status: 400 });
  }

  const expectedDomain = req.headers.get("host");
  if (!expectedDomain) {
    return NextResponse.json({ error: "Missing Host header" }, { status: 400 });
  }

  const parsed = parseSiweMessage(message);
  const chainId = parsed.chainId;
  if (typeof chainId !== "number" || !SUPPORTED_CHAINS[chainId]) {
    return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  }
  if (!parsed.address) {
    return NextResponse.json({ error: "Missing address in SIWE message" }, { status: 400 });
  }

  const client = createPublicClient({ chain: SUPPORTED_CHAINS[chainId], transport: http() });
  const ok = await verifySiweMessage(client, {
    message,
    signature: signature as `0x${string}`,
    nonce: storedNonce,
    domain: expectedDomain,
  });
  if (!ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  session.nonce = undefined;
  session.address = getAddress(parsed.address) as `0x${string}`;
  session.chainId = chainId;
  session.isLoggedIn = true;
  session.signedInAt = new Date().toISOString();
  await session.save();

  return NextResponse.json({ address: session.address, chainId, isLoggedIn: true });
}

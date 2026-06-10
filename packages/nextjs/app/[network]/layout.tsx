import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { chainForSlug } from "~~/utils/scaffold-eth";

/**
 * Validates the `[network]` URL segment against the configured target networks.
 * Unknown slugs (e.g. someone hand-edits the URL to `/foo/programs`) trigger
 * the global not-found page; everything else passes through to the route.
 */
export default async function NetworkLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ network: string }>;
}) {
  const { network } = await params;
  if (!chainForSlug(network)) notFound();
  return <>{children}</>;
}

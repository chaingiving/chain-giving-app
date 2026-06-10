import { useParams, usePathname } from "next/navigation";

/**
 * Returns true when the user is on the app's home page.
 *
 * Home is `/[network]` (e.g. `/baseSepolia`, `/arcTestnet`) — i.e. the
 * pathname is exactly `/` followed by the active network slug, with no
 * further segments.
 */
export function useIsHomePage(): boolean {
  const pathname = usePathname();
  const params = useParams();
  const slug = typeof params?.network === "string" ? params.network : undefined;
  if (!slug) return pathname === "/";
  return pathname === `/${slug}`;
}

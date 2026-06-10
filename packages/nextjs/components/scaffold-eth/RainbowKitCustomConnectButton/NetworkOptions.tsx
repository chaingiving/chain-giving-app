import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useSwitchChain } from "wagmi";
import { ArrowsRightLeftIcon } from "@heroicons/react/24/solid";
import { getNetworkColor, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { getTargetNetworks, slugForChain } from "~~/utils/scaffold-eth";

const allowedNetworks = getTargetNetworks();

type NetworkOptionsProps = {
  hidden?: boolean;
};

/**
 * Renders the network-switch menu for the connect dropdown.
 *
 * The active network is encoded in the path's `[network]` segment, so we
 * swap the leading segment of the current pathname for the target network's
 * slug (e.g. /baseSepolia/programs → /arcTestnet/programs). We also fire
 * `switchChain` to keep the wallet in sync — `<ChainSync />` would do this
 * lazily via an effect, but firing it on the same user gesture feels snappier
 * and lets the wallet popup appear immediately.
 */
export const NetworkOptions = ({ hidden = false }: NetworkOptionsProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const { targetNetwork } = useTargetNetwork();
  const { switchChain } = useSwitchChain();
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === "dark";

  const swapNetworkSegment = (slug: string) => {
    // pathname always starts with "/"; first segment is the current network slug.
    const parts = (pathname ?? "/").split("/");
    parts[1] = slug;
    return parts.join("/") || `/${slug}`;
  };

  return (
    <>
      {allowedNetworks
        .filter(allowedNetwork => allowedNetwork.id !== targetNetwork.id)
        .map(allowedNetwork => {
          const slug = slugForChain(allowedNetwork);
          return (
            <li key={allowedNetwork.id} className={hidden ? "hidden" : ""}>
              <button
                className="menu-item btn-sm rounded-xl! flex gap-3 py-3 whitespace-nowrap"
                type="button"
                onClick={() => {
                  router.push(swapNetworkSegment(slug));
                  switchChain({ chainId: allowedNetwork.id });
                }}
              >
                <ArrowsRightLeftIcon className="h-6 w-4 ml-2 sm:ml-0" />
                <span>
                  Switch to{" "}
                  <span
                    style={{
                      color: getNetworkColor(allowedNetwork, isDarkMode),
                    }}
                  >
                    {allowedNetwork.name}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
    </>
  );
};

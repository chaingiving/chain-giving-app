import { useRef } from "react";
import { getAddress } from "viem";
import { Address } from "viem";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { AccountCard } from "~~/components/AccountCard";
import { useOutsideClick } from "~~/hooks/scaffold-eth";

type AddressInfoDropdownProps = {
  address: Address;
  // Optional pre-resolved name (e.g. ENS) to render in the pill. When omitted
  // the pill always shows a truncated address — see `enableEnsResolution` in
  // scaffold.config.ts.
  displayName?: string;
};

const truncate = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

export const AddressInfoDropdown = ({ address, displayName }: AddressInfoDropdownProps) => {
  const checkSumAddress = getAddress(address);
  const dropdownRef = useRef<HTMLDetailsElement>(null);

  const closeDropdown = () => {
    dropdownRef.current?.removeAttribute("open");
  };

  useOutsideClick(dropdownRef, closeDropdown);

  return (
    <details ref={dropdownRef} className="dropdown dropdown-end leading-3">
      <summary className="flex items-center gap-2 rounded-full bg-base-100 hover:bg-base-200 border border-base-300 shadow-md h-10 px-4 cursor-pointer transition-colors list-none [&::-webkit-details-marker]:hidden">
        <span className="font-mono font-medium text-sm">{displayName ?? truncate(checkSumAddress)}</span>
        <ChevronDownIcon className="h-4 w-4 opacity-70" />
      </summary>
      <div className="dropdown-content z-2 mt-2 px-6 py-6 shadow-center shadow-accent bg-base-100 border border-base-300 rounded-3xl w-72">
        <AccountCard address={checkSumAddress} onLinkClick={closeDropdown} />
      </div>
    </details>
  );
};

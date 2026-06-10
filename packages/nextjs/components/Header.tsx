"use client";

import React, { useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import {
  Bars3Icon,
  BugAntIcon,
  HeartIcon,
  InformationCircleIcon,
  UserGroupIcon,
  WalletIcon,
} from "@heroicons/react/24/outline";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useNetworkHref, useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useEffectiveAddress } from "~~/hooks/useEffectiveAddress";
import { useIsAdmin } from "~~/hooks/useIsAdmin";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
};

export const menuLinks: HeaderMenuLink[] = [
  {
    label: "Home",
    href: "/",
  },
  {
    label: "Organizations",
    href: "/organizations",
    icon: <UserGroupIcon className="h-4 w-4" />,
  },
  {
    label: "Programs",
    href: "/programs",
    icon: <HeartIcon className="h-4 w-4" />,
  },
];

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const networkHref = useNetworkHref();
  // Use the effective on-chain identity so the "Wallet" link points to the
  // Kernel address for social/email logins (where donations land) rather than
  // the raw EOA — they'd otherwise see an empty wallet page.
  const { address: effectiveAddress } = useEffectiveAddress();
  const isAdmin = useIsAdmin();

  const allLinks: HeaderMenuLink[] = [
    ...menuLinks.map(l => ({ ...l, href: networkHref(l.href) })),
    ...(effectiveAddress
      ? [
          {
            label: "Wallet",
            href: networkHref(`/wallet/${effectiveAddress}`),
            icon: <WalletIcon className="h-4 w-4" />,
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            label: "Debug",
            href: networkHref("/debug"),
            icon: <BugAntIcon className="h-4 w-4" />,
          },
        ]
      : []),
    {
      label: "About Us",
      href: "https://chain.giving",
      icon: <InformationCircleIcon className="h-4 w-4" />,
    },
  ];

  return (
    <>
      {allLinks.map(({ label, href, icon }) => {
        const isActive = pathname === href;
        return (
          <li key={href}>
            <Link
              href={href}
              passHref
              className={`${
                isActive ? "bg-secondary shadow-md" : ""
              } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
            >
              {icon}
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
    </>
  );
};

/**
 * Site header
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const networkHref = useNetworkHref();
  const { isConnected } = useAccount();
  const isLocalNetwork = targetNetwork.id === hardhat.id;

  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

  return (
    <div className="sticky lg:static top-0 navbar bg-base-100 min-h-0 shrink-0 justify-between z-20 shadow-md shadow-secondary px-0 sm:px-2">
      <div className="navbar-start w-auto lg:w-1/2">
        <details className="dropdown" ref={burgerMenuRef}>
          <summary className="ml-1 btn btn-ghost lg:hidden hover:bg-transparent">
            <Bars3Icon className="h-1/2" />
          </summary>
          <ul
            className="menu menu-compact dropdown-content mt-3 p-2 shadow-sm bg-base-100 rounded-box w-52"
            onClick={() => {
              burgerMenuRef?.current?.removeAttribute("open");
            }}
          >
            <HeaderMenuLinks />
            <li className="mt-2 border-t border-base-300 pt-2">
              <SwitchTheme className="!justify-start px-3" />
            </li>
          </ul>
        </details>
        <Link href={networkHref("/")} passHref className="hidden lg:flex items-center gap-2 ml-4 mr-6 shrink-0">
          <div className="flex relative w-10 h-10">
            <Image alt="SE2 logo" className="cursor-pointer" fill src="/logo.svg" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold leading-tight">Chain.Giving</span>
            <span className="text-xs">Truthful Giving for Everyone</span>
          </div>
        </Link>
        <ul className="hidden lg:flex lg:flex-nowrap menu menu-horizontal px-1 gap-2">
          <HeaderMenuLinks />
        </ul>
      </div>
      <div className="navbar-end grow mr-4 gap-2">
        {isLocalNetwork && <FaucetButton />}
        {isConnected && <RainbowKitCustomConnectButton />}
        <div className="hidden lg:flex">
          <SwitchTheme />
        </div>
      </div>
    </div>
  );
};

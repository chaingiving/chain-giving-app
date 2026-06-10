"use client";

import Link from "next/link";
import { useNetworkHref } from "~~/hooks/scaffold-eth";

export default function ThankYou() {
  const networkHref = useNetworkHref();
  return (
    <div className="flex items-center min-h-[60vh] justify-center px-4">
      <div className="text-center max-w-md">
        <h1 className="text-4xl font-bold mb-2">Thank you for your donation</h1>
        <p className="opacity-70 mb-6">It is on its way to the program.</p>
        <Link href={networkHref("/")} className="btn btn-primary">
          Back to home
        </Link>
      </div>
    </div>
  );
}

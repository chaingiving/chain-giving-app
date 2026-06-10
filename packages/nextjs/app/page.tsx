import { redirect } from "next/navigation";
import { defaultNetworkSlug } from "~~/utils/scaffold-eth";

/** Root path redirects to the first configured target network (e.g. /baseSepolia). */
export default function Page() {
  redirect(`/${defaultNetworkSlug()}`);
}

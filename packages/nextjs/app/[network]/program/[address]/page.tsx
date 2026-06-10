import { CGProgramView } from "./_components/CGProgramView";
import { isAddress } from "viem";

type PageProps = {
  params: Promise<{ address: string }>;
};

const CGProgramPage = async (props: PageProps) => {
  const { address } = await props.params;

  if (!isAddress(address)) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <p className="text-error text-lg">Invalid contract address.</p>
      </div>
    );
  }

  return <CGProgramView address={address} />;
};

export default CGProgramPage;

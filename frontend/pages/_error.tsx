import { NextPageContext } from "next";
import Link from "next/link";

function ErrorPage({ statusCode }: { statusCode?: number }) {
  return (
    <div className="min-h-screen bg-[#0B0F19] text-white flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-5xl font-bold text-[#10B981] mb-4">
        {statusCode ? `Error ${statusCode}` : "An Error Occurred"}
      </h1>
      <p className="text-gray-400 mb-6 max-w-md">
        {statusCode === 404
          ? "The page you are looking for could not be found."
          : "A server-side error occurred while rendering this page."}
      </p>
      <Link
        href="/"
        className="px-6 py-3 bg-[#10B981] hover:bg-emerald-600 text-white font-semibold rounded-lg transition-colors"
      >
        Return to Home
      </Link>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode : 404;
  return { statusCode };
};

export default ErrorPage;
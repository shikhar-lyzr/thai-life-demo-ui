import { UploadForm } from "@/components/upload-form";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-10 max-w-xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Thai Life Insurance — Document Bundle Processor
        </h1>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400 sm:text-base">
          Upload a multi-page PDF bundle (ID, medical, financial). Returns a structured
          underwriter brief.
        </p>
      </div>
      <UploadForm />
    </main>
  );
}

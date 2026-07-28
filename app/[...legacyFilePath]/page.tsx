import { notFound, redirect } from "next/navigation";
import { buildStandaloneFileUrl, parseLegacyWindowsFilePath } from "@/lib/file-viewer-url";

interface LegacyFilePageProps {
  params: Promise<{ legacyFilePath: string[] }>;
}

/** Compatibility route for historical agent links such as /D:/repo/File.java:11. */
export default async function LegacyFilePage({ params }: LegacyFilePageProps) {
  const { legacyFilePath } = await params;
  const location = parseLegacyWindowsFilePath(`/${legacyFilePath.join("/")}`);
  if (!location) notFound();

  redirect(buildStandaloneFileUrl(location.filePath, {
    line: location.line,
    column: location.column,
  }));
}

import React, { useEffect, useState } from "react";

const h = React.createElement;
const MiB = 1024 * 1024;

type CapabilityKind = "skill" | "function";
interface UploadFile { path: string; contentBase64: string; executable: boolean; type: "file"; }
interface InventoryFile { path: string; executable: boolean; byteLength: number; sha256: string; }
interface ArtifactSummary {
  digest: string; byteCount: number; fileCount: number; contract: unknown; files: InventoryFile[];
}
interface Capability { id: string; slug: string; name: string; kind: CapabilityKind; createdAt: string; }
interface CapabilityDetail extends Capability {
  draft: (ArtifactSummary & { version: string; updatedAt: string }) | null;
  versions: (ArtifactSummary & { version: string; publishedAt: string })[];
}

export function writeRequest(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<Response> {
  const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("capykit_csrf="))?.slice("capykit_csrf=".length);
  return fetch(path, {
    method, credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrf === undefined ? {} : { "x-csrf-token": csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function bytesLabel(bytes: number): string {
  return bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${String(bytes)} bytes`;
}

function validateFiles(files: UploadFile[], kind: CapabilityKind): void {
  if (files.length === 0 || files.length > 512) throw new Error("Choose between 1 and 512 files.");
  if (kind === "function" && (files.length !== 1 || files[0]?.path !== "index.mjs")) throw new Error("A function must contain only index.mjs.");
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    const segments = file.path.split("/");
    if (file.path.length > 1024 || /[\\:\p{Cc}]/u.test(file.path) || segments.some((part) => part === "" || part === "." || part === "..")) throw new Error("File paths must be relative, without parent-directory segments or unsupported characters.");
    if (paths.has(file.path)) throw new Error("The artifact contains duplicate file paths.");
    paths.add(file.path);
    let size: number;
    try { size = atob(file.contentBase64).length; } catch { throw new Error("The artifact contains invalid base64 file content."); }
    if (size > (kind === "function" ? MiB : 8 * MiB)) throw new Error(kind === "function" ? "index.mjs must be 1 MiB or smaller." : "Each skill file must be 8 MiB or smaller.");
    total += size;
    if (total > 32 * MiB) throw new Error("The complete skill must be 32 MiB or smaller.");
  }
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      if (paths.has(segments.join("/"))) throw new Error("A file path conflicts with a directory path.");
      segments.pop();
    }
  }
  if (kind === "skill" && !paths.has("SKILL.md")) throw new Error("Choose the skill folder containing SKILL.md at its root.");
}

async function readFiles(selected: File[], kind: CapabilityKind): Promise<UploadFile[]> {
  if (selected.length === 0 || selected.length > 512) throw new Error("Choose between 1 and 512 files.");
  if (selected.some((file) => file.size > (kind === "function" ? MiB : 8 * MiB)) || selected.reduce((sum, file) => sum + file.size, 0) > 32 * MiB) throw new Error("Upload exceeds the limit: 8 MiB per skill file, 32 MiB per skill, or 1 MiB per function.");
  const files: UploadFile[] = [];
  for (const file of selected) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    // Folder pickers include the chosen directory name; it is not part of the artifact.
    const path = file.webkitRelativePath === "" ? file.name : file.webkitRelativePath.split("/").slice(1).join("/");
    files.push({ path, contentBase64: btoa(binary), executable: false, type: "file" });
  }
  validateFiles(files, kind);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readArtifact(file: File, kind: CapabilityKind): Promise<{ files: UploadFile[]; version?: string }> {
  if (file.size > 48 * MiB) throw new Error("The artifact download must be 48 MiB or smaller.");
  const value: unknown = JSON.parse(await file.text());
  if (typeof value !== "object" || value === null || !("format" in value) || value.format !== "capykit.artifact.v1" || !("artifact" in value)) throw new Error("Choose a Capykit artifact JSON download.");
  const artifact = value.artifact;
  if (typeof artifact !== "object" || artifact === null || !("kind" in artifact) || artifact.kind !== kind || !("files" in artifact) || !Array.isArray(artifact.files)) throw new Error("The artifact kind must match this capability.");
  const files = (artifact.files as unknown[]).map((entry): UploadFile => {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string" || !("contentBase64" in entry) || typeof entry.contentBase64 !== "string" || !("executable" in entry) || typeof entry.executable !== "boolean" || !("type" in entry) || entry.type !== "file") throw new Error("The artifact contains an invalid file entry.");
    return { path: entry.path, contentBase64: entry.contentBase64, executable: entry.executable, type: "file" };
  });
  validateFiles(files, kind);
  return { files, ...("version" in value && typeof value.version === "string" ? { version: value.version } : {}) };
}

function Summary({ artifact }: { artifact: ArtifactSummary }): React.ReactElement {
  return h("div", { className: "artifact-summary" },
    h("p", { className: "muted" }, `${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"} · ${bytesLabel(artifact.byteCount)}`),
    h("p", { className: "digest" }, h("strong", null, "SHA-256 "), h("code", null, artifact.digest)),
    h("details", null, h("summary", null, "File inventory"),
      h("div", { className: "table-scroll" }, h("table", null,
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "File"), h("th", { scope: "col" }, "Size"), h("th", { scope: "col" }, "Executable"))),
        h("tbody", null, ...artifact.files.map((file) => h("tr", { key: file.path }, h("td", null, h("code", null, file.path), h("code", { className: "file-hash" }, `SHA-256 ${file.sha256}`)), h("td", null, bytesLabel(file.byteLength)), h("td", null, file.executable ? "Yes" : "No")))),
      ))),
    artifact.contract === null ? null : h("details", null, h("summary", null, "Function contract"), h("pre", null, JSON.stringify(artifact.contract, null, 2))),
  );
}

const errorMessages: Record<string, string> = {
  FORBIDDEN: "Your current role cannot perform this action. Capability access is limited to workspace owners until grants are available.",
  NOT_FOUND: "This capability or version is no longer available. Refresh the library.",
  INVALID_REQUEST: "Check the capability identifier, version, and file format, then try again.",
  ARTIFACT_INVALID: "The artifact did not pass validation. Check SKILL.md metadata, relative paths, file limits, and credential files. Functions require an async handler in index.mjs with the supported contract.",
  ARTIFACT_LIMIT_EXCEEDED: "This upload exceeds a file or bundle limit. Skills allow 512 files, 8 MiB per file, and 32 MiB total. Functions allow one file up to 1 MiB.",
  CONFLICT: "That identifier or version already exists, or the draft changed. Refresh the capability and use a new version for changed content.",
  ARTIFACT_CORRUPT: "The stored artifact failed its integrity check. Download is unavailable; contact your workspace operator.",
  ARTIFACT_BUSY: "Another artifact upload, publication, or download is in progress. Wait a moment and try again.",
  CSRF_REQUIRED: "Your session needs refreshing. Reload the page and try again.",
};

export function CapabilityLibrary({ onSessionExpired }: { onSessionExpired: () => void }): React.ReactElement {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [selected, setSelected] = useState<CapabilityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<CapabilityKind>("skill");
  const [version, setVersion] = useState("1.0.0");
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [deleting, setDeleting] = useState(false);

  async function checked(response: Response): Promise<Response> {
    if (response.status === 401) {
      onSessionExpired();
      throw new Error("Your session expired or access is no longer available. Sign in again.");
    }
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: { code?: string; requestId?: string } } | null;
      const message = errorMessages[value?.error?.code ?? ""] ?? "The request could not be completed. Check your connection and try again.";
      throw new Error(message + (value?.error?.requestId === undefined ? "" : ` Reference: ${value.error.requestId}`));
    }
    return response;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The request could not be completed. Try again."); }
    finally { setPending(false); }
  }

  async function refresh(): Promise<void> {
    const response = await checked(await fetch("/v1/capabilities", { credentials: "same-origin", cache: "no-store" }));
    const result = await response.json() as { capabilities: Capability[] };
    setCapabilities(result.capabilities);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/v1/capabilities", { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { onSessionExpired(); return; }
      if (!response.ok) throw new Error("Could not load your capabilities. Retry when your connection is available.");
      const result = await response.json() as { capabilities: Capability[] };
      if (!controller.signal.aborted) setCapabilities(result.capabilities);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load capabilities."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [onSessionExpired]);

  function show(detail: CapabilityDetail): void {
    setSelected(detail); setVersion(detail.draft?.version ?? "1.0.0"); setFiles([]); setDeleting(false); setCreating(false);
  }

  async function open(id: string): Promise<void> {
    await run(async () => {
      const response = await checked(await fetch(`/v1/capabilities/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" }));
      show(await response.json() as CapabilityDetail);
    });
  }

  async function create(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const response = await checked(await writeRequest("/v1/capabilities", "POST", { name: name.trim(), slug: slug.trim(), kind }));
      show(await response.json() as CapabilityDetail);
      setName(""); setSlug(""); await refresh();
      setNotice("Capability created. Upload its first version below.");
    });
  }

  async function choose(selectedFiles: File[], artifactImport = false): Promise<void> {
    if (selected === null || selectedFiles.length === 0) return;
    const capabilityKind = selected.kind;
    await run(async () => {
      const imported = artifactImport ? await readArtifact(selectedFiles[0] as File, capabilityKind) : { files: await readFiles(selectedFiles, capabilityKind) };
      setFiles(imported.files);
      if ("version" in imported) setVersion(imported.version);
      setNotice("Files selected. Review executable flags, then save the draft for validation.");
    });
  }

  async function saveDraft(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    if (selected === null) return;
    await run(async () => {
      validateFiles(files, selected.kind);
      const response = await checked(await writeRequest(`/v1/capabilities/${encodeURIComponent(selected.id)}/draft`, "PUT", { version: version.trim(), artifact: { files } }));
      show(await response.json() as CapabilityDetail);
      setNotice("Draft saved and validated. Review its inventory and digest before publishing.");
    });
  }

  async function publish(): Promise<void> {
    if (selected?.draft === null || selected === null) return;
    const draft = selected.draft;
    await run(async () => {
      const response = await checked(await writeRequest(`/v1/capabilities/${encodeURIComponent(selected.id)}/publish`, "POST", { version: draft.version, digest: draft.digest }));
      show(await response.json() as CapabilityDetail);
      setNotice(`Version ${draft.version} published. Its content is now immutable.`);
    });
  }

  async function download(publishedVersion: string): Promise<void> {
    if (selected === null) return;
    await run(async () => {
      const response = await checked(await fetch(`/v1/capabilities/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(publishedVersion)}/download`, { credentials: "same-origin", cache: "no-store" }));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${selected.slug}-${publishedVersion}.capykit.json`;
      anchor.click(); setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
      setNotice(`Version ${publishedVersion} downloaded with all files, executable flags, and invocation guidance.`);
    });
  }

  async function remove(): Promise<void> {
    if (selected === null) return;
    await run(async () => {
      await checked(await writeRequest(`/v1/capabilities/${encodeURIComponent(selected.id)}`, "DELETE"));
      setSelected(null); setDeleting(false); setFiles([]); await refresh();
      setNotice("Capability deleted. Its drafts and published versions are no longer downloadable.");
    });
  }

  const dirty = files.length > 0;
  return h("section", { className: "library", "aria-label": "Capability library", "aria-busy": loading || pending },
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "Workspace library"), h("h1", null, "Capabilities"), h("p", { className: "muted" }, "Store complete skills and reviewed functions. Publish versions you can reuse anywhere.")),
      h("button", { type: "button", disabled: pending, onClick: () => { setCreating(true); setError(""); setNotice(""); } }, "New capability")),
    error === "" ? null : h("p", { className: "message error", role: "alert" }, error),
    notice === "" ? null : h("p", { className: "message success", role: "status" }, notice),
    creating ? h("section", { className: "panel", "aria-label": "Create capability" },
      h("h2", null, "Create a capability"),
      h("form", { onSubmit: (event) => { void create(event); } },
        h("div", { className: "form-grid" },
          h("label", null, "Name", h("input", { required: true, maxLength: 120, value: name, disabled: pending, onChange: (event) => { setName(event.currentTarget.value); }, placeholder: "Repository triage" })),
          h("label", null, "Identifier", h("input", { required: true, maxLength: 80, pattern: "[a-z0-9]+(?:-[a-z0-9]+)*", value: slug, disabled: pending, onChange: (event) => { setSlug(event.currentTarget.value); }, placeholder: "repository-triage", "aria-describedby": "identifier-help" })),
          h("label", null, "Kind", h("select", { value: kind, disabled: pending, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setKind(event.currentTarget.value as CapabilityKind); } }, h("option", { value: "skill" }, "Skill bundle"), h("option", { value: "function" }, "Function"))),
        ),
        h("p", { id: "identifier-help", className: "muted small" }, "Use a stable lowercase identifier with letters, numbers, or hyphens. It cannot be changed later."),
        h("div", { className: "actions" }, h("button", { type: "submit", disabled: pending }, "Create capability"), h("button", { type: "button", className: "secondary", disabled: pending, onClick: () => { setCreating(false); } }, "Cancel")),
      )) : null,
    h("div", { className: "library-layout" },
      h("aside", { className: "panel library-nav", "aria-label": "Your capabilities" },
        h("div", { className: "section-heading compact" }, h("h2", null, "Your library"), h("button", { type: "button", className: "text-button", disabled: pending || loading, onClick: () => { void run(refresh); } }, "Refresh")),
        loading ? h("p", { role: "status" }, "Loading capabilities…") : capabilities.length === 0 ? h("p", { className: "muted" }, "No capabilities yet. Create a skill or function to get started.") : h("ul", { className: "capability-list" }, ...capabilities.map((capability) => h("li", { key: capability.id },
          h("button", { type: "button", className: selected?.id === capability.id ? "capability-item active" : "capability-item", "aria-current": selected?.id === capability.id ? "true" : undefined, disabled: pending, onClick: () => { void open(capability.id); } }, h("span", { className: "kind-badge" }, capability.kind), h("strong", null, capability.name), h("span", { className: "muted small" }, capability.slug)),
        ))),
      ),
      selected === null ? h("section", { className: "panel empty-state" }, h("h2", null, "A home for reusable capabilities"), h("p", { className: "muted" }, "Choose a capability to inspect its draft, publish a version, or download its complete contents."), h("p", { className: "muted small" }, "Skills include SKILL.md and their supporting files. Functions currently support github.issues.list.v1. Publishing makes a version available to workspace owners; grants and execution come later.")) : h("div", { className: "capability-detail" },
        h("section", { className: "panel" },
          h("div", { className: "section-heading" }, h("div", null, h("span", { className: "kind-badge" }, selected.kind), h("h2", null, selected.name), h("p", { className: "muted" }, selected.slug)), h("button", { type: "button", className: "secondary", disabled: pending, onClick: () => { void open(selected.id); } }, "Reload capability")),
          h("h3", null, selected.draft === null ? "Upload a draft" : "Replace the draft"),
          h("p", { className: "muted" }, selected.kind === "skill" ? "Choose the complete folder with SKILL.md at its root. Include scripts, references, and binary assets. SKILL.md needs name and description frontmatter. Maximum 512 files, 8 MiB per file, 32 MiB total." : "Upload one UTF-8 index.mjs, up to 1 MiB, exporting an async handler without imports or dependencies. This function uses the fixed github.issues.list.v1 contract."),
          h("form", { onSubmit: (event) => { void saveDraft(event); } },
            h("label", { className: "version-field" }, "Version", h("input", { required: true, maxLength: 64, pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}", value: version, disabled: pending, onChange: (event) => { setVersion(event.currentTarget.value); }, placeholder: "1.0.0", title: "Start with a letter or number; use letters, numbers, dots, underscores, or hyphens." })),
            h("div", { className: "form-grid uploads" },
              h("label", null, selected.kind === "skill" ? "Skill folder" : "Function source", h("input", { key: `${selected.id}-${selected.kind}`, type: "file", disabled: pending, ...(selected.kind === "skill" ? { multiple: true, webkitdirectory: "" } : { accept: ".mjs" }), onChange: (event) => { const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void choose(chosen); } })),
              h("label", null, "Or import a Capykit download", h("input", { type: "file", accept: ".json,application/json", disabled: pending, onChange: (event) => { const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void choose(chosen, true); } })),
            ),
            files.length === 0 ? null : h("div", { className: "upload-review" },
              h("h4", null, `${String(files.length)} files selected`),
              h("p", { className: "muted small" }, "Folder uploads cannot read executable permissions. Mark executable scripts below. Importing a Capykit download preserves those flags."),
              h("div", { className: "table-scroll" }, h("table", null,
                h("thead", null, h("tr", null, h("th", { scope: "col" }, "File"), h("th", { scope: "col" }, "Executable"))),
                h("tbody", null, ...files.map((file, index) => h("tr", { key: file.path }, h("td", null, h("code", null, file.path)), h("td", null, h("input", { type: "checkbox", checked: file.executable, disabled: pending, "aria-label": `Executable: ${file.path}`, onChange: (event) => { const executable = event.currentTarget.checked; setFiles((current) => current.map((entry, position) => position === index ? { ...entry, executable } : entry)); } }))))),
              ))),
            h("div", { className: "actions" }, h("button", { type: "submit", disabled: pending || !dirty }, pending ? "Working…" : "Save and validate draft"), !dirty ? null : h("button", { type: "button", className: "secondary", disabled: pending, onClick: () => { setFiles([]); setVersion(selected.draft?.version ?? "1.0.0"); setNotice(""); } }, "Discard selected files")),
          ),
        ),
        selected.draft === null ? null : h("section", { className: "panel", "aria-label": "Saved draft" }, h("div", { className: "section-heading" }, h("h3", null, `Draft · ${selected.draft.version}`), h("span", { className: "status-badge" }, "Unpublished")),
          h(Summary, { artifact: selected.draft }),
          h("p", { className: "muted small" }, "Publishing permanently fixes these files, their executable flags, and the contract to this version. A later change requires a new version."),
          h("button", { type: "button", disabled: pending || dirty || version.trim() !== selected.draft.version, onClick: () => { void publish(); } }, `Publish ${selected.draft.version}`),
          !dirty && version.trim() === selected.draft.version ? null : h("p", { className: "muted small" }, "Save or discard your upload changes before publishing the saved draft."),
        ),
        h("section", { className: "panel", "aria-label": "Published versions" }, h("h3", null, "Published versions"),
          selected.versions.length === 0 ? h("p", { className: "muted" }, "No published versions yet.") : selected.versions.map((published) => h("article", { className: "published-version", key: published.version },
            h("div", { className: "section-heading" }, h("div", null, h("h4", null, published.version), h("p", { className: "muted small" }, `Published ${new Date(published.publishedAt).toLocaleString()}`)), h("button", { type: "button", className: "secondary", disabled: pending, onClick: () => { void download(published.version); } }, `Download ${published.version}`)), h(Summary, { artifact: published }),
          )),
          h("p", { className: "muted small" }, "Downloads include every file as base64, original paths, executable flags, a verified digest, and invocation guidance in one portable JSON artifact."),
        ),
        h("section", { className: "panel deletion", "aria-label": "Delete capability" },
          deleting ? h("div", null, h("h3", null, `Delete ${selected.name}?`), h("p", null, "This removes its draft and all published versions from the workspace. Future downloads stop immediately. Existing downloaded copies and backups are not erased."), h("div", { className: "actions" }, h("button", { type: "button", className: "danger", disabled: pending, onClick: () => { void remove(); } }, "Delete capability and versions"), h("button", { type: "button", className: "secondary", disabled: pending, onClick: () => { setDeleting(false); } }, "Keep capability"))) : h("button", { type: "button", className: "text-button danger-text", disabled: pending, onClick: () => { setDeleting(true); } }, "Delete capability"),
        ),
      ),
    ),
  );
}

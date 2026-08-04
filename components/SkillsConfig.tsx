"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillSearchResult } from "@/app/api/skills/search/route";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsInput,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsState,
  SettingsSurface,
  SettingsTab,
  SettingsTabs,
  SettingsToggle,
} from "@/components/ui/SettingsPrimitives";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: { source?: string; scope?: string };
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  const source = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (source?.startsWith("webui-bundled:")) return "bundled";
  if (scope === "user" || source === "user") return "global";
  if (scope === "project" || source === "project") return "project";
  return "path";
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
}) {
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;
  const bundled = label === "bundled";
  const displayPath = label === "project" && skill.filePath.startsWith(cwd)
    ? `./${skill.filePath.slice(cwd.length).replace(/^[/\\]/, "")}`
    : shortenPath(skill.filePath);

  return (
    <SettingsSection className="skill-detail">
      <SettingsSectionHeader
        title={skill.name}
        description={skill.description}
        meta={<code className="resource-path">{displayPath}</code>}
        action={<SettingsBadge tone={label === "project" ? "accent" : "neutral"}>{label}</SettingsBadge>}
      />
      <SettingsToggle
        label="Available to the model"
        description={bundled
          ? "Bundled skills are read-only here. Disable the owning package in Settings → Extensions."
          : enabled
            ? "This skill is included in the model prompt."
            : "This skill is hidden from the model prompt."}
        checked={enabled}
        disabled={toggling || bundled}
        onChange={() => onToggle(skill)}
      />
      {saveError && <SettingsNotice tone="danger">{saveError}</SettingsNotice>}
      <SettingsSurface>
        <span className="settings-surface-title">Skill source</span>
        <code className="resource-path">{displayPath}</code>
        <span className="settings-surface-muted">Base directory: {shortenPath(skill.baseDir)}</span>
      </SettingsSurface>
    </SettingsSection>
  );
}

function AddSkillPanel({ cwd, onInstalled }: { cwd: string; onInstalled: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const search = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const response = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: value.trim() }),
      });
      const payload = (await response.json()) as { results?: SkillSearchResult[]; error?: string };
      if (payload.error) {
        setSearchError(payload.error);
        return;
      }
      setResults(payload.results ?? []);
      if ((payload.results ?? []).length === 0) setSearchError("No skills found");
    } catch (reason) {
      setSearchError(String(reason));
    } finally {
      setSearching(false);
    }
  }, []);

  const install = useCallback(async (pkg: string) => {
    setInstalling(pkg);
    setInstallError(null);
    try {
      const response = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: pkg, scope, cwd }),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || payload.error) {
        setInstallError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      setInstalledPkgs((previous) => new Set(previous).add(pkg));
      onInstalled();
    } catch (reason) {
      setInstallError(String(reason));
    } finally {
      setInstalling(null);
    }
  }, [cwd, onInstalled, scope]);

  const installPath = scope === "global" ? "~/.pi/agent/skills/" : `${shortenPath(cwd)}/.pi/agent/skills/`;

  return (
    <SettingsSection className="skill-add-panel">
      <SettingsSectionHeader title="Add Skill" description={<>Search <a href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a> and install into the selected scope.</>} />
      <SettingsActionRow className="skill-search-row">
        <SettingsInput
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void search(query); }}
          placeholder="e.g. react, testing, deploy"
        />
        <SettingsButton variant="primary" onClick={() => void search(query)} disabled={!query.trim()} busy={searching}>
          {searching ? "Searching…" : "Search"}
        </SettingsButton>
      </SettingsActionRow>
      <SettingsActionRow>
        <SettingsTabs aria-label="Install scope">
          <SettingsTab active={scope === "global"} onClick={() => setScope("global")}>Global</SettingsTab>
          <SettingsTab active={scope === "project"} onClick={() => setScope("project")}>Project</SettingsTab>
        </SettingsTabs>
        <code className="resource-path">→ {installPath}</code>
      </SettingsActionRow>

      {searchError && <SettingsNotice tone="warning">{searchError}</SettingsNotice>}
      {installError && <SettingsNotice tone="danger">{installError}</SettingsNotice>}

      {searching ? (
        <SettingsState kind="loading" title="Searching skills…" />
      ) : results.length > 0 ? (
        <div className="skill-search-results">
          {results.map((result) => {
            const installed = installedPkgs.has(result.package);
            const isInstalling = installing === result.package;
            const atIndex = result.package.indexOf("@");
            const repository = atIndex > -1 ? result.package.slice(0, atIndex) : result.package;
            const name = atIndex > -1 ? result.package.slice(atIndex + 1) : repository;
            return (
              <div key={result.package} className="skill-search-result">
                <div className="resource-list-copy">
                  <div className="resource-list-title">{name}</div>
                  <div className="skill-result-meta">
                    <code>{repository}</code>
                    <span>{result.installs} installs</span>
                    {result.url && <a href={result.url} target="_blank" rel="noreferrer">skills.sh ↗</a>}
                  </div>
                </div>
                <SettingsButton
                  size="sm"
                  variant={installed ? "secondary" : "primary"}
                  disabled={installed || installing !== null}
                  busy={isInstalling}
                  onClick={() => { if (!installed && !isInstalling) void install(result.package); }}
                >
                  {installed ? "✓ Installed" : isInstalling ? "Installing…" : "Install"}
                </SettingsButton>
              </div>
            );
          })}
        </div>
      ) : !searchError ? (
        <SettingsState title="Search for a skill to install." description="Results include package source and install count before you choose a scope." />
      ) : null}
    </SettingsSection>
  );
}

export function SkillsConfig({ cwd, onClose, embed }: { cwd: string; onClose: () => void; embed?: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);

  const loadSkills = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
      .then((response) => response.json())
      .then((payload: { skills?: Skill[]; error?: string }) => {
        if (payload.error) {
          setError(payload.error);
          return;
        }
        const list = payload.skills ?? [];
        setSkills(list);
        if (list.length > 0 && !selected) setSelected(list[0].filePath);
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [cwd, selected]);

  useEffect(() => { loadSkills(); }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((previous) => new Set(previous).add(skill.filePath));
    setSaveError(null);
    try {
      const response = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: skill.filePath, disableModelInvocation: next }),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || payload.error) {
        setSaveError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      setSkills((previous) => previous.map((item) => item.filePath === skill.filePath ? { ...item, disableModelInvocation: next } : item));
    } catch (reason) {
      setSaveError(String(reason));
    } finally {
      setToggling((previous) => {
        const nextSet = new Set(previous);
        nextSet.delete(skill.filePath);
        return nextSet;
      });
    }
  }, []);

  const selectedSkill = skills.find((skill) => skill.filePath === selected) ?? null;
  const groups = ["project", "global", "path"].map((label) => ({ label, skills: skills.filter((skill) => sourceLabel(skill) === label) })).filter((group) => group.skills.length > 0);

  const panelContent = (
        <div className={embed ? "resource-split-body skills-embed-body" : "pi-modal-split-body resource-split-body"}>
          <aside className="resource-split-nav" aria-label="Installed skills">
            <div className="resource-split-list">
              {loading ? <SettingsState kind="loading" title="Loading skills…" /> : error ? <SettingsState kind="error" title="Could not load skills" description={error} /> : skills.length === 0 ? <SettingsState title="No skills found" /> : groups.map((group) => (
                <div key={group.label} className="resource-nav-group">
                  <div className="resource-nav-group-title">{group.label}</div>
                  {group.skills.map((skill) => {
                    const active = !addMode && selected === skill.filePath;
                    return (
                      <button
                        key={skill.filePath}
                        type="button"
                        className={`resource-nav-row${active ? " resource-nav-row-active" : ""}`}
                        onClick={() => { setSelected(skill.filePath); setAddMode(false); }}
                        title={skill.name}
                      >
                        <span className={`resource-status-dot${skill.disableModelInvocation ? " resource-status-dot-muted" : ""}`} aria-hidden="true" />
                        <span>{skill.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="resource-split-nav-footer">
              <SettingsButton variant={addMode ? "primary" : "secondary"} onClick={() => setAddMode(true)}>+ Add skill</SettingsButton>
            </div>
          </aside>

          <main className="resource-split-detail">
            {addMode ? (
              <AddSkillPanel cwd={cwd} onInstalled={loadSkills} />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail key={selectedSkill.filePath} skill={selectedSkill} cwd={cwd} onToggle={toggle} toggling={toggling.has(selectedSkill.filePath)} saveError={saveError} />
            ) : (
              <SettingsState title="Select a skill" />
            )}
          </main>
        </div>
  );

  if (embed) return panelContent;
  return (
    <div className="pi-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="skills-config-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pi-modal-panel pi-modal-panel-large resource-split-panel">
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id="skills-config-title" className="pi-modal-title">Skills</div>
            <div className="pi-modal-subtitle resource-path">{shortenPath(cwd)}</div>
          </div>
          <button type="button" onClick={onClose} className="pi-modal-close" aria-label="Close skills">×</button>
        </div>

        {panelContent}

        <div className="pi-modal-footer"><SettingsButton onClick={onClose}>Close</SettingsButton></div>
      </div>
    </div>
  );
}

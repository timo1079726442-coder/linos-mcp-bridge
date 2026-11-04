import React from "react";
import { NavLink } from "react-router-dom";
import { primarySections, type PrimarySectionId } from "../../navigation/sections.ts";
import { useI18n } from "../../i18n/index.tsx";

/** v2 IA: sections grouped; labels come from i18n so both languages stay in sync. */
const groups: ReadonlyArray<{ labelKey: string; items: readonly PrimarySectionId[] }> = [
  { labelKey: "nav.group.work", items: ["overview", "connect", "services", "jobs", "collaboration"] },
  { labelKey: "nav.group.resources", items: ["workspace", "security", "diagnostics"] },
  { labelKey: "nav.group.system", items: ["settings"] },
];

export function PrimaryNavigation(): JSX.Element {
  const { t } = useI18n();
  return (
    <nav className="primary-nav" aria-label={t("nav.main")}>
      {groups.map((group) => {
        const groupLabel = t(group.labelKey);
        return (
          <div className="nav-group" key={group.labelKey} aria-label={groupLabel}>
            <div className="nav-group-title">{groupLabel}</div>
            {group.items.map((id) => {
              const section = primarySections.find((entry) => entry.id === id);
              const index = groups.flatMap((entry) => entry.items).indexOf(id);
              if (!section) return null;
              const label = t(`nav.${section.id}`);
              const help = t(`nav.help.${section.id}`);
              return (
                <NavLink
                  key={section.id}
                  to={section.path}
                  end={section.path === "/"}
                  title={help}
                  aria-label={`${label} / ${help}`}
                  className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
                >
                  <span className="nav-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className="nav-label">{label}</span>
                </NavLink>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

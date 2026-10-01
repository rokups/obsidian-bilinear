// What the Vue components need from their surroundings. The Obsidian view
// implements it; the components themselves never import `obsidian`.

import type { InjectionKey } from "vue";
import type { IssueRecord } from "../format/record";
import type { NewIssue } from "../ops/issues";
import type { ViewSpec } from "../store/query";

export interface MenuEntry {
  title?: string;
  icon?: string;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface Host {
  setIcon(el: HTMLElement, icon: string): void;
  showMenu(event: MouseEvent, entries: MenuEntry[]): void;
  notice(message: string): void;
  confirm(title: string, message: string, action: string): Promise<boolean>;
  prompt(title: string, placeholder: string, initial?: string): Promise<string | null>;
  /** Open an issue note; `focus` moves keyboard focus to it. */
  openIssue(issue: IssueRecord, focus: boolean): void;
  newIssue(defaults: Partial<NewIssue>): void;
  openAsMarkdown(): void;
  lint(): void;
  author(): string;
  /** The view spec changed and should be remembered with the workspace. */
  specChanged(spec: ViewSpec): void;
}

export const HOST: InjectionKey<Host> = Symbol("bilinear-host");

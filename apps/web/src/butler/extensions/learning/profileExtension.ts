import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  ButlerExtension,
  ButlerExtensionContext,
} from '../../../kernel/butlerExtensions';
import {
  confirmProfileFact,
  createProfileFact,
  parseBootstrapButlerProfileText,
  parseExternalButlerProfileMarkdown,
  renderButlerProfileMarkdown,
  setProfileFactStatus,
} from './profileFacts';
import type {
  OperationAction,
  ProfileFact,
  ProfileFactKind,
} from './model';

export const BUTLER_PROFILE_EXTENSION_ID = 'rocketx.butler.profile';

export interface ButlerProfileProjection {
  mirror(markdown: string): void;
  watch(onChange: (markdown: string) => void): Promise<() => void>;
}

export interface ButlerProfileExtensionState {
  facts: ProfileFact[];
  rejectedLines: string[];
}

export interface ButlerProfileExtensionApi {
  store: StoreApi<ButlerProfileExtensionState>;
  addExplicit(kind: ProfileFactKind, subject: string, value: string): ProfileFact;
  proposeObserved(kind: ProfileFactKind, subject: string, value: string): ProfileFact;
  addBootstrapCandidates(
    entries: readonly { kind: ProfileFactKind; subject: string; value: string }[],
    origin: 'bootstrap-connected' | 'bootstrap-imported',
  ): number;
  reviewBootstrap(markdown: string, origin: 'bootstrap-imported'): number;
  confirm(id: string): void;
  revoke(id: string): void;
  restore(id: string): void;
  reviewExternal(markdown: string): number;
  markdown(): string;
}

interface ButlerOperationEvent {
  action: OperationAction;
  intentKey: string;
  surface: string;
}

function factKey(fact: Pick<ProfileFact, 'kind' | 'subject' | 'value' | 'replacesId'>): string {
  return `${fact.kind}:${fact.subject}:${fact.value}:${fact.replacesId ?? ''}`;
}

function savedState(context: ButlerExtensionContext): ButlerProfileExtensionState {
  const saved = context.readState<Partial<ButlerProfileExtensionState>>();
  return {
    facts: Array.isArray(saved?.facts) ? saved.facts : [],
    rejectedLines: Array.isArray(saved?.rejectedLines)
      ? saved.rejectedLines.filter((line): line is string => typeof line === 'string')
      : [],
  };
}

export function createButlerProfileExtension(
  projection: ButlerProfileProjection,
): ButlerExtension<ButlerProfileExtensionApi> {
  return {
    manifest: { id: BUTLER_PROFILE_EXTENSION_ID, version: '1.0.0' },
    activate(context) {
      const store = createStore<ButlerProfileExtensionState>(() => savedState(context));
      const persist = () => {
        const state = store.getState();
        context.writeState(state);
        projection.mirror(renderButlerProfileMarkdown(state.facts));
      };
      const operation = (event: ButlerOperationEvent) =>
        context.emit<ButlerOperationEvent>('butler.operation', event);
      const setFacts = (facts: ProfileFact[]) => {
        store.setState({ facts });
        persist();
      };
      const api: ButlerProfileExtensionApi = {
        store,
        addExplicit: (kind, subject, value) => {
          const fact = createProfileFact({
            kind,
            subject,
            value,
            origin: 'explicit',
            confirmed: true,
          });
          const facts = store.getState().facts.map((current) =>
            current.kind === kind && current.subject === fact.subject && current.status === 'confirmed'
              ? { ...current, status: 'revoked' as const, updatedAt: fact.createdAt }
              : current);
          setFacts([...facts, fact]);
          operation({ action: 'confirm-profile', intentKey: `profile:${kind}`, surface: 'profile' });
          return fact;
        },
        proposeObserved: (kind, subject, value) => {
          const fact = createProfileFact({ kind, subject, value, origin: 'observed' });
          setFacts([...store.getState().facts, fact]);
          return fact;
        },
        addBootstrapCandidates: (entries, origin) => {
          const current = store.getState();
          const existingKeys = new Set(current.facts.map((fact) => factKey(fact)));
          const additions = entries.flatMap((entry) => {
            try {
              const fact = createProfileFact({
                kind: entry.kind,
                subject: entry.subject,
                value: entry.value,
                origin,
              });
              if (existingKeys.has(factKey(fact))) return [];
              existingKeys.add(factKey(fact));
              return [fact];
            } catch {
              return [];
            }
          });
          if (additions.length) {
            store.setState({ facts: [...current.facts, ...additions] });
            persist();
          }
          return additions.length;
        },
        reviewBootstrap: (markdown, origin) => {
          const current = store.getState();
          const parsed = parseBootstrapButlerProfileText(markdown, current.facts, origin);
          const existingKeys = new Set(current.facts.map((fact) => factKey(fact)));
          const additions = parsed.candidates.filter((fact) => !existingKeys.has(factKey(fact)));
          if (additions.length || parsed.rejectedLines.length) {
            store.setState({
              facts: [...current.facts, ...additions],
              rejectedLines: parsed.rejectedLines,
            });
            persist();
          }
          return additions.length;
        },
        confirm: (id) => {
          setFacts(confirmProfileFact(store.getState().facts, id));
          operation({ action: 'confirm-profile', intentKey: `profile:${id}`, surface: 'profile' });
        },
        revoke: (id) => {
          setFacts(setProfileFactStatus(store.getState().facts, id, 'revoked'));
          operation({ action: 'revoke-profile', intentKey: `profile:${id}`, surface: 'profile' });
        },
        restore: (id) => setFacts(setProfileFactStatus(store.getState().facts, id, 'confirmed')),
        reviewExternal: (markdown) => {
          const current = store.getState();
          const parsed = parseExternalButlerProfileMarkdown(markdown, current.facts);
          const existingKeys = new Set(current.facts.map((fact) => factKey(fact)));
          const additions = parsed.candidates.filter((fact) => !existingKeys.has(factKey(fact)));
          if (additions.length || parsed.rejectedLines.length) {
            store.setState({
              facts: [...current.facts, ...additions],
              rejectedLines: parsed.rejectedLines,
            });
            persist();
          }
          return additions.length;
        },
        markdown: () => renderButlerProfileMarkdown(store.getState().facts),
      };
      projection.mirror(api.markdown());
      context.on('host.storage-ready', () => {
        store.setState(savedState(context), true);
        projection.mirror(api.markdown());
      });
      let stopWatching: (() => void) | undefined;
      void projection.watch(api.reviewExternal).then((stop) => {
        stopWatching = stop;
      }).catch(() => undefined);
      return {
        api,
        dispose: () => stopWatching?.(),
      };
    },
  };
}

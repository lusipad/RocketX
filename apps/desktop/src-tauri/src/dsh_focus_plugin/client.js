window.__ModuleLoader__.load({
	id: "rocketx-dsh-focus",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const inject = ["sessions", "workspaces"];
		function postToParent(message, targetOrigin) {
			window.parent.postMessage(message, targetOrigin || "*");
		}
		function hasSession(list, sessionId) {
			const snapshot = list.getSnapshot();
			return typeof snapshot === "object" && snapshot !== null && typeof snapshot.byId === "object" && snapshot.byId !== null && Object.prototype.hasOwnProperty.call(snapshot.byId, sessionId);
		}
		function apply(ctx) {
			ctx.effect(() => {
				let cancelWait = null;
				let waitTimer = null;
				let requestGeneration = 0;
				const clearWait = () => {
					if (cancelWait !== null) {
						cancelWait();
						cancelWait = null;
					}
					if (waitTimer !== null) {
						clearTimeout(waitTimer);
						waitTimer = null;
					}
				};
				const acknowledge = (requestId, action, targetOrigin, sessionId) => {
					postToParent({
						type: "rocketx:dsh-ack",
						requestId,
						action,
						...(sessionId === void 0 ? {} : { sessionId })
					}, targetOrigin);
				};
				const reportError = (requestId, action, error, targetOrigin, sessionId) => {
					postToParent({
						type: "rocketx:dsh-error",
						requestId,
						action,
						...(sessionId === void 0 ? {} : { sessionId }),
						error
					}, targetOrigin);
				};
				const focusSession = (requestId, sessionId, targetOrigin, generation) => {
					clearWait();
					const tryOpen = () => {
						if (generation !== requestGeneration) return true;
						if (!hasSession(ctx.sessions.list, sessionId)) return false;
						try {
							ctx.sessions.open(sessionId);
							acknowledge(requestId, "focus-session", targetOrigin, sessionId);
						} catch (error) {
							reportError(requestId, "focus-session", error instanceof Error ? error.message : String(error), targetOrigin, sessionId);
						}
						return true;
					};
					if (tryOpen()) return;
					cancelWait = ctx.sessions.list.subscribe(() => {
						if (!tryOpen()) return;
						clearWait();
					});
					waitTimer = setTimeout(() => {
						clearWait();
						if (generation !== requestGeneration) return;
						reportError(requestId, "focus-session", "session did not appear in time", targetOrigin, sessionId);
					}, 10000);
				};
				const openWorkspaceSession = async (requestId, workspacePath, targetOrigin, generation) => {
					clearWait();
					if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
						if (generation === requestGeneration) reportError(requestId, "open-new-session", "invalid workspacePath", targetOrigin);
						return;
					}
					try {
						const workspace = await ctx.workspaces.create({ path: workspacePath });
						if (generation !== requestGeneration) return;
						const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId);
						if (generation !== requestGeneration) return;
						ctx.sessions.open(sessionId);
						acknowledge(requestId, "open-new-session", targetOrigin, sessionId);
					} catch (error) {
						if (generation !== requestGeneration) return;
						reportError(requestId, "open-new-session", error instanceof Error ? error.message : String(error), targetOrigin);
					}
				};
				const onMessage = (event) => {
					if (event.source !== window.parent) return;
					const data = event.data;
					if (typeof data !== "object" || data === null) return;
					if (data.type === "rocketx:dsh-ready-request") {
						postToParent({ type: "rocketx:dsh-ready" }, event.origin);
						return;
					}
					if (typeof data.requestId !== "string" || data.requestId.length === 0) return;
					if (data.type === "rocketx:dsh-open-new-session") {
						const generation = ++requestGeneration;
						void openWorkspaceSession(data.requestId, data.workspacePath, event.origin, generation);
						return;
					}
					if (data.type !== "rocketx:dsh-focus-session") return;
					const generation = ++requestGeneration;
					if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
						reportError(data.requestId, "focus-session", "invalid sessionId", event.origin);
						return;
					}
					focusSession(data.requestId, data.sessionId, event.origin, generation);
				};
				window.addEventListener("message", onMessage);
				postToParent({
					type: "rocketx:dsh-ready"
				}, "*");
				return () => {
					requestGeneration += 1;
					clearWait();
					window.removeEventListener("message", onMessage);
				};
			}, "rocketx dsh focus bridge");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

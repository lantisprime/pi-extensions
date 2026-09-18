// herdr-control test fixtures: canned herdr CLI outputs (herdr 0.8.0 shapes).

export const AGENT_LIST_JSON = JSON.stringify({
	id: "cli:agent:list",
	result: {
		agents: [
			{
				agent: "claude",
				agent_status: "done",
				pane_id: "w1:p1",
				tab_id: "w1:t1",
				workspace_id: "w1",
				cwd: "/tmp/project-a",
				focused: false,
			},
			{
				agent: "pi",
				agent_status: "working",
				pane_id: "w9:p1",
				tab_id: "w9:t1",
				workspace_id: "w9",
				cwd: "/Users/x/pi-extensions",
				focused: true,
			},
		],
	},
	type: "agent_list",
});

export const AGENT_GET_JSON = JSON.stringify({
	id: "cli:agent:get",
	result: {
		agent: {
			agent: "pi-herdr-reviewer",
			agent_status: "idle",
			pane_id: "w9:p3",
			tab_id: "w9:t1",
			workspace_id: "w9",
			cwd: "/Users/x/pi-extensions",
			focused: false,
		},
	},
	type: "agent_info",
});

export const PANE_SPLIT_JSON = JSON.stringify({
	id: "cli:pane:split",
	result: {
		pane: { pane_id: "w9:p4", tab_id: "w9:t1", workspace_id: "w9" },
	},
	type: "pane_split",
});

export const WORKSPACE_CREATE_JSON = JSON.stringify({
	id: "cli:workspace:create",
	result: {
		workspace: { id: "w12" },
		tab: { id: "w12:t1" },
		root_pane: { pane_id: "w12:p1" },
	},
	type: "workspace_create",
});

export const PANE_LAYOUT_JSON = JSON.stringify({
	id: "cli:pane:layout",
	result: {
		layout: {
			area: { height: 56, width: 157, x: 20, y: 1 },
			focused_pane_id: "w9:p1",
			panes: [{ focused: true, pane_id: "w9:p1", rect: { height: 56, width: 157, x: 20, y: 1 } }],
			splits: [],
			tab_id: "w9:t1",
			workspace_id: "w9",
			zoomed: false,
		},
	},
	type: "pane_layout",
});

export const PANE_LAYOUT_TALL_JSON = JSON.stringify({
	id: "cli:pane:layout",
	result: {
		layout: {
			area: { height: 60, width: 40, x: 0, y: 0 },
			focused_pane_id: "w9:p1",
			panes: [{ focused: true, pane_id: "w9:p1", rect: { height: 60, width: 40, x: 0, y: 0 } }],
			splits: [],
			tab_id: "w9:t1",
			workspace_id: "w9",
			zoomed: false,
		},
	},
	type: "pane_layout",
});

export const AGENT_START_JSON = JSON.stringify({
	id: "cli:agent:start",
	result: {
		agent: { agent: "pi-herdr-reviewer", agent_status: "idle", pane_id: "w9:p4" },
	},
	type: "agent_info",
});

export const AGENT_PROMPT_OK_JSON = JSON.stringify({
	id: "cli:agent:prompt",
	result: {
		agent: { agent: "pi-herdr-reviewer", agent_status: "idle", pane_id: "w9:p4" },
	},
	type: "agent_prompt",
});

export function stderrError(code, message) {
	return JSON.stringify({ error: { code, message } });
}

export const ERR_BLOCKED = stderrError("agent_blocked", "agent is blocked at a dialog");
export const ERR_STALLED = stderrError("agent_prompt_stalled", "no lifecycle change observed within 5000ms");
export const ERR_TIMEOUT = stderrError("timeout", "wait timed out after 300000ms");
export const ERR_NOT_RUNNING = stderrError("agent_not_running", "agent is not running");
export const ERR_NOT_READY = stderrError("agent_not_ready", "agent detected but not ready");
export const ERR_NOT_IDLE = stderrError("agent_not_idle", "agent is not idle; history read unavailable");

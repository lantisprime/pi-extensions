#!/usr/bin/env bash
set -euo pipefail

dashboard_name="${TMUX_GHOSTTY_DASHBOARD:-ghostty-tmux-sessions}"
mode="${TMUX_GHOSTTY_MODE:-tab}"
dashboard_created=0

usage() {
	printf 'Usage: %s [--dashboard-name NAME] [--window]\n' "$0"
	printf '\n'
	printf 'Opens Ghostty with a tmux dashboard containing one pane per tmux session.\n'
	printf 'The script keeps running until you press Esc or Ctrl-C.\n'
	printf '\n'
	printf 'Options:\n'
	printf '  --dashboard-name NAME  tmux session name for the dashboard.\n'
	printf '  --window               Open a new Ghostty window instead of using Cmd-T.\n'
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

shell_quote() {
	printf "'"
	printf '%s' "$1" | sed "s/'/'\\\\''/g"
	printf "'"
}

find_ghostty_app() {
	if [[ -d /Applications/Ghostty.app ]]; then
		printf '%s\n' /Applications/Ghostty.app
		return 0
	fi

	local ghostty_bin
	ghostty_bin="$(command -v ghostty 2>/dev/null || true)"
	if [[ -n "$ghostty_bin" ]]; then
		local app_path
		app_path="$(osascript -e 'POSIX path of (path to application "Ghostty")' 2>/dev/null || true)"
		if [[ -n "$app_path" && -d "$app_path" ]]; then
			printf '%s\n' "${app_path%/}"
			return 0
		fi
	fi

	return 1
}

open_ghostty_window() {
	local command_string="$1"
	local app_path
	app_path="$(find_ghostty_app)" || die "Ghostty.app was not found"

	open -na "$app_path" --args -e /bin/bash -lc "$command_string"
}

open_ghostty_tab() {
	local command_string="$1"
	local app_path old_clipboard had_clipboard
	app_path="$(find_ghostty_app)" || die "Ghostty.app was not found"

	open -a "$app_path"

	had_clipboard=0
	old_clipboard="$(pbpaste 2>/dev/null || true)"
	if pbpaste >/dev/null 2>&1; then
		had_clipboard=1
	fi

	printf '%s' "$command_string" | pbcopy

	osascript <<'APPLESCRIPT'
tell application "Ghostty" to activate
delay 0.2
tell application "System Events"
	keystroke "t" using command down
	delay 0.2
	keystroke "v" using command down
	key code 36
end tell
APPLESCRIPT

	if [[ "$had_clipboard" == 1 ]]; then
		printf '%s' "$old_clipboard" | pbcopy
	fi
}

session_command() {
	local session_name="$1"
	local quoted_session
	quoted_session="$(shell_quote "$session_name")"

	printf 'env -u TMUX tmux attach-session -t %s; exec "${SHELL:-/bin/zsh}" -l' \
		"$quoted_session"
}

safe_window_name() {
	local name="$1"
	name="${name//[^[:alnum:]_.-]/-}"
	printf '%s\n' "${name:0:60}"
}

cleanup_dashboard() {
	[[ "$dashboard_created" == 1 ]] || return 0
	tmux has-session -t "$dashboard_name" 2>/dev/null || return 0

	local marker
	marker="$(tmux show-options -qv -t "$dashboard_name" '@ghostty_tmux_dashboard' 2>/dev/null || true)"
	[[ "$marker" == 1 ]] || return 0

	tmux kill-session -t "$dashboard_name" 2>/dev/null || true
}

wait_until_stopped() {
	printf 'Press Esc or Ctrl-C in this terminal to close dashboard session %s.\n' "$dashboard_name"

	if [[ ! -t 0 ]]; then
		while true; do
			sleep 3600
		done
	fi

	local old_stty key
	old_stty="$(stty -g)"
	trap 'stty "$old_stty"; printf "\n"; cleanup_dashboard; exit 130' INT TERM

	stty -echo -icanon time 1 min 0
	while true; do
		key=""
		IFS= read -r -s -n 1 key || true
		[[ "$key" == $'\e' ]] && break
	done

	stty "$old_stty"
	trap - INT TERM
	cleanup_dashboard
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dashboard-name)
			[[ $# -ge 2 ]] || die "--dashboard-name requires a value"
			dashboard_name="$2"
			shift 2
			;;
		--window)
			mode="window"
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			die "unknown argument: $1"
			;;
	esac
done

command -v tmux >/dev/null 2>&1 || die "tmux is not installed or is not on PATH"
command -v osascript >/dev/null 2>&1 || die "osascript is required on macOS"
command -v open >/dev/null 2>&1 || die "open is required on macOS"

list_output="$(tmux list-sessions -F '#{session_name}' 2>&1)" || {
	case "$list_output" in
		*"no server running"*|*"failed to connect"*)
			die "no tmux sessions found"
			;;
		*)
			die "tmux list-sessions failed: $list_output"
			;;
	esac
}

sessions=()
while IFS= read -r session_name; do
	[[ -n "$session_name" ]] || continue
	[[ "$session_name" == "$dashboard_name" ]] && continue
	sessions+=("$session_name")
done <<< "$list_output"

[[ ${#sessions[@]} -gt 0 ]] || die "no tmux sessions found"

if tmux has-session -t "$dashboard_name" 2>/dev/null; then
	marker="$(tmux show-options -qv -t "$dashboard_name" '@ghostty_tmux_dashboard' 2>/dev/null || true)"
	[[ "$marker" == 1 ]] || die "tmux session '$dashboard_name' already exists and was not created by this script"
	tmux kill-session -t "$dashboard_name"
fi

first_session="${sessions[0]}"
tmux new-session -d -s "$dashboard_name" -n "$(safe_window_name "$first_session")" "$(session_command "$first_session")"
dashboard_created=1
trap cleanup_dashboard EXIT
tmux set-option -t "$dashboard_name" -q '@ghostty_tmux_dashboard' 1
tmux set-window-option -t "$dashboard_name" -q remain-on-exit on

for session_name in "${sessions[@]:1}"; do
	tmux split-window -t "$dashboard_name:0" "$(session_command "$session_name")"
	tmux select-layout -t "$dashboard_name:0" tiled >/dev/null
done

tmux select-pane -t "$dashboard_name:0.0"
attach_command="tmux attach-session -t $(shell_quote "$dashboard_name")"

case "$mode" in
	tab)
		open_ghostty_tab "$attach_command"
		;;
	window)
		open_ghostty_window "$attach_command"
		;;
	*)
		die "unknown mode: $mode"
		;;
esac

printf 'Opened Ghostty %s for dashboard session %s with %d tmux session(s).\n' \
	"$mode" \
	"$dashboard_name" \
	"${#sessions[@]}"

wait_until_stopped

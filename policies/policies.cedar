// Allow main session to create a PR when the branch has no open PR
// and we're not on the default branch.
@id("create_pr_when_no_upstream")
permit (
  principal == Session::"main",
  action == Action::"CreatePR",
  resource
)
when {
  context.has_open_pr == false &&
  context.branch != "" &&
  context.is_default_branch == false
};

// Allow main session to edit the current branch's PR. The model passes
// `pr: "current"` (tool_pr_number == 0) by default, or it may pass the
// actual number explicitly — both are fine as long as it matches.
@id("edit_current_pr")
permit (
  principal == Session::"main",
  action == Action::"EditPR",
  resource
)
when {
  context.has_open_pr == true &&
  (context.tool_pr_number == 0 || context.tool_pr_number == context.current_pr_number)
};

// Hard guard: never let any caller target a PR number other than the one
// associated with the current branch.
@id("forbid_cross_pr_targeting")
forbid (
  principal,
  action == Action::"EditPR",
  resource
)
when {
  context.tool_pr_number != 0 &&
  context.tool_pr_number != context.current_pr_number
};

// Hard guard: refuse to mutate when the worktree/PR lookup failed
// (not in a git repo, gh not authed, etc. — hook signals this by
// setting branch == "").
@id("forbid_mutate_without_branch")
forbid (
  principal,
  action in [Action::"CreatePR", Action::"EditPR"],
  resource
)
when { context.branch == "" };

// Hard guard: never create a PR while checked out on the default branch.
@id("forbid_create_from_default_branch")
forbid (
  principal,
  action == Action::"CreatePR",
  resource
)
when { context.is_default_branch == true };

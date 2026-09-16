# shellcheck shell=bash
#
# A single-writer lock over the cursor store.
#
# Copied from `cli/quote-ladder`, not imported, per CONTRIBUTING § 1. There it
# guards the order book; here it guards a directory of sequence numbers, which
# is the same hazard wearing different clothes: two monitors sharing one cursor
# store both advance the same file, and the loser's write silently rolls the
# cursor *backwards*. A cursor that goes backwards is worse than no cursor at
# all — it makes the next resume ask for a replay it will be told is fine, and
# the gap in between is never reported.
#
# Three properties, chosen deliberately:
#
# **`mkdir`, not a file test.** `[[ -e lock ]] && exit || touch lock` is two
# operations with a window between them, and both runs can pass the test. A
# `mkdir` either creates the directory or fails, in one step, on every POSIX
# filesystem — which is what makes it a lock at all.
#
# **`mkdir`, not `flock`.** `flock(1)` is util-linux and is not installed on a
# stock macOS, and an example that only locks on Linux locks nowhere it matters.
#
# **Non-blocking, always.** A held lock is reported and the run exits 75
# (EX_TEMPFAIL); it never waits. A monitor under a restart policy that blocked
# on its predecessor would pile up processes until the box fell over, which is
# a worse failure than a refused start and a much harder one to read afterwards.

LOCK_DIR=""
LOCK_HELD=0

# How old a pid-less lock directory must be before it is treated as orphaned
# rather than as a run still between `mkdir` and `_lock_claim`. That window is
# microseconds wide; a minute is four orders of magnitude of headroom, so this
# never races a healthy start and still clears a wedged store without a manual
# `rmdir`. `--unlock` is the deliberate path; this is the automatic one.
LOCK_ORPHAN_SECONDS=${LOCK_ORPHAN_SECONDS:-60}

# Is `$1` a live process?
#
# Errs towards "alive" on anything ambiguous. Stealing the cursor store from a
# monitor that is mid-write is the expensive mistake; refusing to start is the
# cheap one, so every uncertain case resolves towards refusing.
_lock_pid_alive() {
  local pid=$1 err
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  if err=$(kill -0 "$pid" 2>&1); then
    return 0
  fi
  # A failure is only proof of death when the kernel said "no such process".
  # Anything else — most often EPERM, a live process owned by another user — is
  # treated as alive.
  case "$(lower "$err")" in
    *"no such process"*) return 1 ;;
    *) return 0 ;;
  esac
}

# Age of a file in whole seconds, or the empty string if it cannot be told.
# `stat` is spelled differently on GNU and BSD and this is only ever used in a
# diagnostic, so both spellings are tried and neither is required.
_lock_file_age() {
  local file=$1 mtime="" now
  mtime=$(stat -c %Y "$file" 2>/dev/null) || mtime=$(stat -f %m "$file" 2>/dev/null) || return 0
  [[ $mtime =~ ^[0-9]+$ ]] || return 0
  now=$(date -u +%s)
  printf '%s' "$(( now - mtime ))"
}

# lock_acquire <dir> — take the lock or exit.
lock_acquire() {
  LOCK_DIR=$1
  mkdir -p -- "$(dirname -- "$LOCK_DIR")" ||
    die "$EX_CONFIG" "cannot create the state directory $(dirname -- "$LOCK_DIR")"

  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    _lock_claim
    return 0
  fi

  # Someone holds it, or someone left it behind. Deciding which needs the pid,
  # and the pid file is written *after* the directory exists, so a missing one
  # is not evidence of a crash — it is most likely a run that started
  # microseconds ago. That case refuses too.
  local pid="" age
  [[ -r "$LOCK_DIR/pid" ]] && read -r pid <"$LOCK_DIR/pid" 2>/dev/null
  age=$(_lock_file_age "$LOCK_DIR/pid")

  if [[ -z $pid ]]; then
    # A pid-less lock is normally a run that started microseconds ago, between
    # `mkdir` and `_lock_claim`'s `printf`, and refusing is right. But it is
    # ALSO the wedged state a crash in that same window leaves behind, and
    # before `lock_release` was made atomic it was the state a failed `rmdir`
    # left too — and that one never clears on its own (@nvizble, #23).
    #
    # The two are told apart by age: a directory older than the claim window by
    # orders of magnitude cannot be a run still inside it. The age is taken
    # from the DIRECTORY here, since the pid file is the thing that is missing,
    # and an unmeasurable age refuses — keeping the uncertain case on the safe
    # side, the way `_lock_pid_alive` does.
    local dir_age
    dir_age=$(_lock_file_age "$LOCK_DIR")
    if [[ $dir_age =~ ^[0-9]+$ ]] && (( dir_age >= LOCK_ORPHAN_SECONDS )); then
      warn "clearing an orphaned lock at $LOCK_DIR: no pid was ever recorded and it is ${dir_age}s old"
    else
      die "$EX_BUSY" "another monitor holds $LOCK_DIR (no pid recorded yet). The cursor store was not touched; try again, or ./run.sh --unlock if it persists."
    fi
  elif _lock_pid_alive "$pid"; then
    die "$EX_BUSY" "another monitor holds $LOCK_DIR (pid $pid, ${age:-unknown} seconds old). The cursor store was not touched; try again."
  else
    warn "clearing a stale lock at $LOCK_DIR: pid $pid is gone (${age:-unknown} seconds old)"
  fi

  # Clearing it has its own race — two runs can both see the same dead pid — so
  # the removal is done by renaming the directory aside. Exactly one `mv` can
  # succeed, which picks a single winner.
  #
  # What happens to the LOSER is not what this comment used to claim. It said
  # "the loser's `mv` fails, its `mkdir` below fails too, and it refuses" —
  # wrong, and @nvizble caught it on #23: the winner moves the directory aside
  # and only recreates it after `rm -rf`, so the loser's `mkdir` lands in that
  # window and SUCCEEDS, and it is the winner's later `mkdir` that fails and
  # refuses. Exactly one holder either way, so the outcome was never unsafe —
  # but a reader auditing this lock against the stated reasoning was auditing
  # against something false, which is worse than no comment.
  #
  # Deleting in place instead would let the loser delete the winner's freshly
  # created lock, which is the thing the rename actually prevents.
  local aside="$LOCK_DIR.stale.$$"
  if mv -- "$LOCK_DIR" "$aside" 2>/dev/null; then
    rm -rf -- "$aside"
  fi

  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    _lock_claim
    return 0
  fi
  die "$EX_BUSY" "another monitor took $LOCK_DIR while a stale lock was being cleared. The cursor store was not touched; try again."
}

_lock_claim() {
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  LOCK_HELD=1
}

# lock_release — give the lock back, but only if it is still ours.
#
# Called from run.sh's EXIT trap, so it runs on a clean finish, an error under
# `set -e`, and a Ctrl-C alike. The pid check is what keeps a late-firing trap
# from deleting a lock that some other run has since taken: the sequence "our
# lock is cleared as stale → another run takes it → our trap fires" is unlikely
# and entirely possible, and without the check it would leave two monitors
# advancing one cursor store with no lock at all.
lock_release() {
  (( LOCK_HELD )) || return 0
  local owner=""
  [[ -r "$LOCK_DIR/pid" ]] && read -r owner <"$LOCK_DIR/pid" 2>/dev/null
  if [[ $owner == "$$" ]]; then
    # Rename aside, then delete — never `rm -f pid` followed by `rmdir`.
    #
    # The old order had no recovery from a partial failure: if `rmdir` failed
    # for any reason (a stray file, an NFS sillyname), the pid file was already
    # gone and the directory remained, so every later `lock_acquire` took the
    # "no pid recorded yet" branch and died EX_BUSY forever, with no way out
    # the error message mentioned (@nvizble, #23).
    #
    # `mv` is atomic on one filesystem, so an observer sees the lock either
    # intact or absent — never the pid-less state that had no exit. If the `mv`
    # fails the lock is left whole, which is the recoverable direction.
    local aside="$LOCK_DIR.released.$$"
    if mv -- "$LOCK_DIR" "$aside" 2>/dev/null; then
      rm -rf -- "$aside"
    fi
  fi
  LOCK_HELD=0
}

# lock_break <dir> — clear a lock left behind by a crashed run. `--unlock`.
#
# Deliberately NOT a force: it refuses while the recorded pid is alive, because
# the failure this exists to fix is a lock with no live owner, and taking one
# from a running monitor is the mistake `_lock_pid_alive` is written to avoid.
# A lock directory with no pid file at all is exactly the wedged state above,
# so that one clears.
lock_break() {
  local dir=$1 pid="" age
  if [[ ! -d $dir ]]; then
    info "no lock at $dir; nothing to clear"
    return 0
  fi
  [[ -r "$dir/pid" ]] && read -r pid <"$dir/pid" 2>/dev/null
  age=$(_lock_file_age "$dir/pid")
  if [[ -n $pid ]] && _lock_pid_alive "$pid"; then
    die "$EX_BUSY" "refusing to clear $dir: pid $pid is alive (${age:-unknown} seconds old). Stop that monitor first."
  fi
  local aside="$dir.broken.$$"
  if mv -- "$dir" "$aside" 2>/dev/null; then
    rm -rf -- "$aside"
    info "cleared the lock at $dir (recorded pid ${pid:-none}, ${age:-unknown} seconds old)"
  else
    die "$EX_CONFIG" "could not clear $dir; remove it by hand"
  fi
}

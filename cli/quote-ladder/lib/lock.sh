# shellcheck shell=bash
#
# A single-writer lock, so two overlapping runs cannot both place the ladder.
#
# This is the one genuine concurrency hazard in a CLI workflow: the tool is meant
# to be run on a timer, and a run that takes longer than the timer's interval
# overlaps the next one. Two runs that each read "no orders are open" and then
# each place three rungs leave six orders on the book — twice the intended
# exposure, from code where every individual step was correct.
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
# (EX_TEMPFAIL); it never waits. Nothing here can deadlock, because nothing here
# ever waits for anything — a timer-driven job that blocks on its predecessor
# just piles up processes until the box falls over, which is a worse failure than
# a skipped cycle and a much harder one to read afterwards.

LOCK_DIR=""
LOCK_HELD=0

# Is `$1` a live process?
#
# Errs towards "alive" on anything ambiguous. Stealing a lock from a run that is
# still placing orders is the expensive mistake; refusing to run for one cycle is
# the cheap one, so every uncertain case resolves towards refusing.
_lock_pid_alive() {
  local pid=$1 err
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  if err=$(kill -0 "$pid" 2>&1); then
    return 0
  fi
  # A failure is only proof of death when the kernel said "no such process".
  # Anything else — most often EPERM, a live process owned by another user — is
  # treated as alive.
  case ${err,,} in
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
  # and the pid file is written *after* the directory exists, so a missing one is
  # not evidence of a crash — it is most likely a run that started microseconds
  # ago. That case refuses too.
  local pid="" age
  [[ -r "$LOCK_DIR/pid" ]] && read -r pid <"$LOCK_DIR/pid" 2>/dev/null
  age=$(_lock_file_age "$LOCK_DIR/pid")

  if [[ -z $pid ]]; then
    die "$EX_BUSY" "another run holds $LOCK_DIR (no pid recorded yet). Nothing was changed; try again."
  fi

  if _lock_pid_alive "$pid"; then
    die "$EX_BUSY" "another run holds $LOCK_DIR (pid $pid, ${age:-unknown} seconds old). Nothing was changed; try again."
  fi

  warn "clearing a stale lock at $LOCK_DIR: pid $pid is gone (${age:-unknown} seconds old)"

  # Clearing it has its own race — two runs can both see the same dead pid — so
  # the removal is done by renaming the directory aside. Exactly one `mv` can
  # succeed, which picks a single winner; the loser's `mv` fails, its `mkdir`
  # below fails too, and it refuses. Deleting in place instead would let the
  # loser delete the *winner's* freshly created lock.
  local aside="$LOCK_DIR.stale.$$"
  if mv -- "$LOCK_DIR" "$aside" 2>/dev/null; then
    rm -rf -- "$aside"
  fi

  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    _lock_claim
    return 0
  fi
  die "$EX_BUSY" "another run took $LOCK_DIR while a stale lock was being cleared. Nothing was changed; try again."
}

_lock_claim() {
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  LOCK_HELD=1
}

# lock_release — give the lock back, but only if it is still ours.
#
# Called from run.sh's EXIT trap, so it runs on a clean finish, an error under
# `set -e`, and a Ctrl-C alike. The pid check is what keeps a late-firing trap
# from deleting a lock that some other run has since taken: the sequence
# "our lock is cleared as stale → another run takes it → our trap fires" is
# unlikely and entirely possible, and without the check it would leave two
# writers running with no lock at all.
lock_release() {
  (( LOCK_HELD )) || return 0
  local owner=""
  [[ -r "$LOCK_DIR/pid" ]] && read -r owner <"$LOCK_DIR/pid" 2>/dev/null
  if [[ $owner == "$$" ]]; then
    rm -f -- "$LOCK_DIR/pid"
    rmdir -- "$LOCK_DIR" 2>/dev/null || true
  fi
  LOCK_HELD=0
}

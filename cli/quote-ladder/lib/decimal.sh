# shellcheck shell=bash
#
# Exact decimal arithmetic for money, on bash integers.
#
# Why this file exists at all: the Exchange sends and accepts prices as decimal
# *strings* ("69694.11250", "0.10"), and every obvious way to do arithmetic on
# them in a shell script goes through a float.
#
#   awk 'BEGIN { printf "%d", 69694.1125 * 0.995 }'   # a double, then truncated
#   echo "69694.1125 * 0.995" | bc                    # bc is not always installed
#
# A double is fine for printing and wrong for orders: the venue only accepts a
# price that is an exact multiple of the market's tick size, so the last digit
# is not cosmetic — it decides whether the order is accepted at all. And an
# order priced off a rounded mid can land on the wrong side of the spread.
#
# So every value here is carried as an integer mantissa plus a decimal scale,
# the pair is only ever combined at a common scale, and division always floors
# in a stated direction. No floats, no `bc`, no `awk`: just bash's 64-bit
# integers, which is why `guard` below matters.
#
# Convention: functions take and return decimal *strings*, so callers never
# handle a bare mantissa. The internal (mantissa, scale) form is echoed as
# "M S" by `dec_parse` and consumed with `read -r`.

# Bash arithmetic is 64-bit and **wraps silently** on overflow — there is no
# error to catch, just a wrong number. 18 digits is the widest value that cannot
# overflow while being scaled up by one more digit, so every mantissa is checked
# against it at the point it is built.
readonly DEC_MAX_DIGITS=18

# Strip leading zeros from a digit string, textually.
#
# Textually, and before the string reaches `$(( ))`, for two reasons: bash reads
# a leading-zero literal as *octal* (`$((09))` is an error, `$((010))` is 8),
# and a digit string longer than 64 bits has to be rejected before it is
# converted, not after.
_dec_strip_zeros() {
  local digits=${1#"${1%%[!0]*}"}
  printf '%s' "${digits:-0}"
}

# Fail unless a mantissa of `$1` digits fits in bash's integers.
#
# Length, not the value: the check has to happen *before* the digits reach
# `$(( ))`, since by then a too-wide number has already wrapped.
_dec_guard() {
  local digits=$1 what=$2
  if (( digits > DEC_MAX_DIGITS )); then
    die 2 "decimal: $what needs $digits digits, more than the $DEC_MAX_DIGITS bash integers hold exactly (refusing rather than wrapping silently)"
  fi
}

# dec_parse <string> -> "<mantissa> <scale>"
#
# Accepts an optional sign, digits, and an optional fractional part. Rejects
# everything else *including* exponent notation: `1e-8` is a number a JSON
# encoder can legitimately produce, and reading it as `1` would be a silent
# hundred-million-fold error, so it has to be a refusal and not a fallback.
dec_parse() {
  local raw=$1 what=${2:-value} sign=1 int frac
  [[ $raw =~ ^[+-]?[0-9]+(\.[0-9]+)?$ ]] ||
    die 2 "decimal: $what is not a plain decimal number: '$raw'"

  case $raw in
    -*) sign=-1; raw=${raw#-} ;;
    +*) raw=${raw#+} ;;
  esac

  int=${raw%%.*}
  frac=""
  [[ $raw == *.* ]] && frac=${raw#*.}

  local digits
  digits=$(_dec_strip_zeros "$int$frac")
  _dec_guard "${#digits}" "$what ('$1')"

  local mantissa=$(( 10#$digits ))
  (( sign < 0 )) && mantissa=$(( -mantissa ))
  printf '%s %s' "$mantissa" "${#frac}"
}

# dec_str <mantissa> <scale> -> canonical decimal string
#
# Canonical means: no `+`, no leading zeros beyond one, no trailing fractional
# zeros, no trailing point. That is what makes it usable as a comparison key —
# the venue echoes "69000.0" for a price this script computed as "69000", and
# comparing the two as strings is how a reconciler ends up cancelling and
# replacing an order that was already correct, on every single run.
dec_str() {
  local mantissa=$1 scale=$2 sign="" digits
  (( mantissa < 0 )) && { sign="-"; mantissa=$(( -mantissa )); }
  digits=$mantissa

  if (( scale > 0 )); then
    while (( ${#digits} <= scale )); do digits="0$digits"; done
    local int=${digits:0:${#digits}-scale} frac=${digits:${#digits}-scale}
    frac=${frac%"${frac##*[!0]}"}          # drop trailing zeros
    if [[ -n $frac ]]; then
      printf '%s%s.%s' "$sign" "$int" "$frac"
      return
    fi
    digits=$int
  fi
  # `-0` is not a price. Normalising it here keeps every caller from having to.
  [[ $digits == 0 ]] && sign=""
  printf '%s%s' "$sign" "$digits"
}

# dec_norm <string> -> the same number, canonically formatted.
dec_norm() {
  local m s
  read -r m s <<<"$(dec_parse "$1" "${2:-value}")"
  dec_str "$m" "$s"
}

# dec_align <a> <b> -> "<mantissa-a> <mantissa-b> <scale>"
#
# Upscales the shallower value to the deeper one's scale. Only ever upscales:
# downscaling would drop digits, which is precisely the silent loss this file
# exists to prevent.
dec_align() {
  local ma sa mb sb
  read -r ma sa <<<"$(dec_parse "$1" "${3:-left}")"
  read -r mb sb <<<"$(dec_parse "$2" "${4:-right}")"

  local scale=$sa
  (( sb > scale )) && scale=$sb
  local shift_a=$(( scale - sa )) shift_b=$(( scale - sb ))

  # Guarded before multiplying, because the multiply itself would wrap in
  # silence. `${#x}` on the absolute value: the sign is not a digit.
  local abs_a=${ma#-} abs_b=${mb#-}
  _dec_guard "$(( ${#abs_a} + shift_a ))" "'$1' scaled to $scale decimals"
  _dec_guard "$(( ${#abs_b} + shift_b ))" "'$2' scaled to $scale decimals"

  while (( shift_a-- > 0 )); do ma=$(( ma * 10 )); done
  while (( shift_b-- > 0 )); do mb=$(( mb * 10 )); done
  printf '%s %s %s' "$ma" "$mb" "$scale"
}

# dec_cmp <a> <b> -> prints -1, 0 or 1
dec_cmp() {
  local ma mb scale
  read -r ma mb scale <<<"$(dec_align "$1" "$2")"
  if (( ma < mb )); then printf '%s' -1
  elif (( ma > mb )); then printf '%s' 1
  else printf '%s' 0
  fi
}

# dec_eq <a> <b> — true when the two are numerically equal, whatever their
# spelling. "0.10" == ".1"-style differences are the whole point.
dec_eq() { [[ $(dec_cmp "$1" "$2") == 0 ]]; }

# dec_lt / dec_gt / dec_lte — the comparisons the callers actually read as prose.
dec_lt()  { [[ $(dec_cmp "$1" "$2") == -1 ]]; }
dec_gt()  { [[ $(dec_cmp "$1" "$2") == 1 ]]; }
dec_lte() { [[ $(dec_cmp "$1" "$2") != 1 ]]; }

# dec_add <a> <b> / dec_sub <a> <b>
dec_add() {
  local ma mb scale
  read -r ma mb scale <<<"$(dec_align "$1" "$2")"
  dec_str "$(( ma + mb ))" "$scale"
}
dec_sub() {
  local ma mb scale
  read -r ma mb scale <<<"$(dec_align "$1" "$2")"
  dec_str "$(( ma - mb ))" "$scale"
}

# dec_bps <value> <bps> -> floor(value * bps / 10000), at value's scale.
#
# The multiply is split rather than done directly, because `mantissa * bps` is
# where a legitimate price overflows 64 bits: a mark price carried at eight
# decimals is already ~1e13, and one more factor of 1e4 puts it past the limit.
# Splitting into whole and remainder parts keeps both intermediates bounded and
# the result exactly floored, with no float anywhere.
dec_bps() {
  local value=$1 bps=$2 m s
  read -r m s <<<"$(dec_parse "$value" "value")"
  [[ $bps =~ ^[0-9]+$ ]] || die 2 "decimal: bps must be a non-negative integer, got '$bps'"
  (( m >= 0 )) || die 2 "decimal: dec_bps expects a non-negative value, got '$value'"
  (( bps <= 10000 )) || die 2 "decimal: bps must be <= 10000 (100%), got '$bps'"
  dec_str "$(( (m / 10000) * bps + ((m % 10000) * bps) / 10000 ))" "$s"
}

# dec_snap <value> <grid> <down|up> -> the nearest multiple of <grid>, in the
# stated direction.
#
# Never "nearest". Rounding a bid to the nearest tick can move it *up*, across
# the spread, turning a resting order into a crossing one — so the direction is
# always the caller's explicit choice, and always the conservative one.
dec_snap() {
  local value=$1 grid=$2 dir=$3 mv mg scale
  read -r mv mg scale <<<"$(dec_align "$value" "$grid" "value" "grid")"
  (( mg > 0 )) || die 2 "decimal: grid must be positive, got '$grid'"

  # True floor. Bash division truncates toward zero, which is not the same thing
  # for a negative numerator, and a price offset can be negative.
  local q=$(( mv / mg )) r=$(( mv % mg ))
  (( r < 0 )) && q=$(( q - 1 ))
  r=$(( mv - q * mg ))

  case $dir in
    down) ;;
    up) (( r != 0 )) && q=$(( q + 1 )) ;;
    *) die 2 "decimal: dec_snap direction must be 'down' or 'up', got '$dir'" ;;
  esac
  dec_str "$(( q * mg ))" "$scale"
}

# dec_units <value> <grid> -> how many whole <grid>s make up <value>.
#
# Used to name a price by its tick count, which gives a client order id that is
# short, has no `.` in it, and is identical for two runs that computed the same
# price. Refuses a value that is not on the grid rather than rounding, because
# every caller here has already snapped.
dec_units() {
  local mv mg scale
  read -r mv mg scale <<<"$(dec_align "$1" "$2" "value" "grid")"
  (( mg > 0 )) || die 2 "decimal: grid must be positive, got '$2'"
  (( mv % mg == 0 )) || die 2 "decimal: '$1' is not an exact multiple of '$2'"
  printf '%s' "$(( mv / mg ))"
}

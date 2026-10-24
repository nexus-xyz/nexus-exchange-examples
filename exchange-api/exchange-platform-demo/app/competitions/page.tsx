import { Terminal } from "@/components/Terminal";

/*
 * /competitions — the Seasons incentive programme.
 *
 * Renders the same terminal shell with the competitions screen preselected, so
 * the route is deep-linkable while the nav, market ticker and status bar stay
 * exactly as they are everywhere else. Screen state remains owned by Terminal.
 */
export default function Page() {
  return <Terminal initialScreen="competitions" />;
}

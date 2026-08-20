import { homedir } from "node:os"
import { join } from "node:path"
export const resolveDshHome = () => process.env.DSH_SMOKE_HOME ?? join(homedir(), ".dsh")

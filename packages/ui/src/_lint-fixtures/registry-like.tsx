// The registry's exact import, in a file that is not the registry: proves the
// lucide-react override is scoped to packages/ui/src/icons/registry.tsx alone.
import { createLucideIcon, type LucideIcon } from 'lucide-react';

export const make: (name: string) => LucideIcon = (name) => createLucideIcon(name, []);

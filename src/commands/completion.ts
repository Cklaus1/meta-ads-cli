import { Command } from 'commander';
import { handleErrors } from '../errors.js';
import { describeCommandTree, describeOption } from './schema.js';

type Shell = 'bash' | 'zsh' | 'fish';

interface CompletionNode {
  subcommands: string[];
  options: string[];
}

/** Map "command path" → its subcommands and option flags. The root is "". */
export function completionTable(program: Command): Map<string, CompletionNode> {
  const tree = describeCommandTree(program);
  const table = new Map<string, CompletionNode>();
  const globalFlags = program.options.filter(o => !o.hidden).flatMap(o => optionFlags(describeOption(o).flags));
  table.set('', { subcommands: [], options: [...globalFlags, '--help', '--version'] });
  for (const cmd of tree) {
    const parent = cmd.path.slice(0, -1).join(' ');
    table.get(parent)?.subcommands.push(cmd.path[cmd.path.length - 1], ...cmd.aliases);
    table.set(cmd.name, { subcommands: [], options: [...cmd.options.flatMap(o => optionFlags(o.flags)), ...globalFlags, '--help'] });
  }
  return table;
}

function optionFlags(flags: string): string[] {
  return flags.split(/[ ,|]+/).filter(f => f.startsWith('-'));
}

function shellQuote(words: string[]): string {
  return words.map(w => w.replace(/[^A-Za-z0-9_./:=-]/g, '')).join(' ');
}

export function generateCompletion(program: Command, shell: Shell): string {
  const table = completionTable(program);
  const name = program.name();
  const fn = `_${name.replace(/[^A-Za-z0-9]/g, '_')}_complete`;

  if (shell === 'fish') {
    // Fish: offer the next level of subcommands, then that command's flags.
    const lines = [`# fish completion for ${name}`, `complete -c ${name} -f`];
    for (const [path, node] of table) {
      const words = path ? path.split(' ') : [];
      const cond = words.length === 0
        ? '__fish_use_subcommand'
        : `__fish_seen_subcommand_from ${words[words.length - 1]}`;
      if (node.subcommands.length) {
        lines.push(`complete -c ${name} -n '${cond}' -a '${shellQuote(node.subcommands)}'`);
      }
      for (const flag of node.options.filter(f => f.startsWith('--'))) {
        lines.push(`complete -c ${name} -n '${cond}' -l ${flag.slice(2)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  // Bash and zsh share one function: walk the typed words down the table.
  const cases = [...table].map(([path, node]) => {
    const words = shellQuote([...node.subcommands, ...node.options]);
    return `    "${path}") echo "${words}" ;;`;
  }).join('\n');

  const body = `${fn}_words() {
  case "$1" in
${cases}
  esac
}

${fn}() {
  local cur path word i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  path=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    [[ "$word" == -* ]] && continue
    local candidate="\${path:+$path }$word"
    if [[ -n "$(${fn}_words "$candidate")" ]]; then path="$candidate"; fi
  done
  COMPREPLY=( $(compgen -W "$(${fn}_words "$path")" -- "$cur") )
}
complete -F ${fn} ${name}
`;
  if (shell === 'zsh') {
    return `# zsh completion for ${name}\nautoload -U +X bashcompinit && bashcompinit\n${body}`;
  }
  return `# bash completion for ${name}\n${body}`;
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion <shell>')
    .description('Print a shell completion script (bash, zsh or fish)')
    .addHelpText('after', `
Examples:
  meta-ads completion bash > /etc/bash_completion.d/meta-ads
  echo 'source <(meta-ads completion zsh)' >> ~/.zshrc
  meta-ads completion fish > ~/.config/fish/completions/meta-ads.fish`)
    .action(handleErrors(async (shell: string) => {
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
        throw new Error(`Unsupported shell "${shell}". Use bash, zsh or fish.`);
      }
      process.stdout.write(generateCompletion(program, shell));
    }));
}


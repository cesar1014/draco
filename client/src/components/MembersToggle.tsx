import { PeopleIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

/**
 * O contador de pessoas do canto superior direito, que abre e fecha o painel de
 * membros. É a única porta pra ele no desktop e no celular: um controle só, no
 * mesmo lugar, em vez de um botão por tamanho de tela.
 */
export function MembersToggle() {
  const count = useStore((state) => {
    const ids = new Set((state.roster[state.activeGuildId] ?? []).map((entry) => entry.id));
    return Object.values(state.members).filter(
      (member) => ids.has(member.id) || (member.guest && member.guestGuildId === state.activeGuildId),
    ).length;
  });
  const membersOpen = useStore((state) => state.membersOpen);
  const setMembersOpen = useStore((state) => state.setMembersOpen);

  return (
    <button
      type="button"
      className="members-toggle"
      data-on={membersOpen}
      aria-expanded={membersOpen}
      onClick={() => setMembersOpen(!membersOpen)}
      title={membersOpen ? "Esconder membros" : "Mostrar membros"}
    >
      <PeopleIcon size={15} />
      <strong>{count}</strong>
      <span>{count === 1 ? "pessoa" : "pessoas"}</span>
    </button>
  );
}

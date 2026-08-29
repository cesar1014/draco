import { useState } from "react";
import { GuildCreateModal } from "@/components/GuildAdmin";
import { BrandMark } from "@/components/Icons";

/**
 * O que a pessoa vê quando não é membro de nenhum servidor — o estado normal de
 * quem acabou de entrar, porque o app não tem servidor de demonstração.
 *
 * Antes havia dois servidores semeados no boot, e eles resolviam este vazio ao
 * custo de todo mundo cair no mesmo lugar sem dono: nem privado, nem
 * administrável. Sem eles, a tela precisa dizer o que fazer, e o que fazer são só
 * dois caminhos — criar o seu, ou colar o convite de alguém.
 */
export function Welcome() {
  const [tab, setTab] = useState<"create" | "join" | null>(null);

  return (
    <div className="welcome">
      <BrandMark size={96} />
      <h1>Você ainda não está em nenhum servidor</h1>
      <p>
        Um servidor é onde ficam os canais de texto e de voz do seu grupo. Crie o seu — ele nasce só
        seu, e só quem você convidar entra — ou entre no de alguém com o link de convite.
      </p>

      <div className="welcome-actions">
        <button type="button" className="primary-button" onClick={() => setTab("create")}>
          Criar servidor
        </button>
        <button type="button" className="secondary-button" onClick={() => setTab("join")}>
          Tenho um convite
        </button>
      </div>

      {tab && <GuildCreateModal initialTab={tab} onClose={() => setTab(null)} />}
    </div>
  );
}

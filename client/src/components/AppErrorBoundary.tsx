import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrandMark } from "@/components/Icons";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Um erro de renderização não deve voltar a parecer uma página vazia. A tela
 * abaixo mantém uma saída clara e permite buscar uma versão nova sem apagar a
 * sessão ou as preferências da pessoa.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Falha ao renderizar o Draco", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="fatal-error" role="alert">
        <section className="fatal-error-card">
          <BrandMark size={64} />
          <h1>O Draco não conseguiu abrir esta tela</h1>
          <p>Recarregue para buscar a versão mais recente. Sua conta e suas conversas não serão apagadas.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Recarregar o Draco
          </button>
        </section>
      </main>
    );
  }
}

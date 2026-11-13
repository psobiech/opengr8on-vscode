# opengr8on-vscode

*[English version](README.en.md)*

> **Uwaga:** Dokumentacja i opisy formatów zawarte w tym repozytorium mogą zawierać błędy,
> nieścisłości lub domysły. Nie gwarantujemy ich dokładności ani kompletności.
>
> Rozszerzenie zmienia program działający na prawdziwych CLU (wysyłanie OM.LUA / USER.LUA, nadawanie
> klucza, restart). Przed użyciem zachowaj kopię projektu Object Managera i zacznij od jednego CLU.

Rozszerzenie VS Code dla CLU zgodnych z Grenton (CLU_ZWAVE_2, CLU na ESP32 z
[opengr8on-clu-esp32](https://github.com/psobiech/opengr8on-clu-esp32), vCLU) — alternatywa dla Object Managera: projekt
instalacji to pliki tekstowe (YAML + Lua), które edytujesz w VS Code i przechowujesz w gicie.

**Stan: pierwsza kompletna wersja, jeszcze nie wypróbowana na sprzęcie.** Generator odtwarza pliki
OM.LUA / USER.LUA Object Managera bajt w bajt dla wszystkich sprawdzonych prawdziwych plików (zob.
[format OM.LUA](docs/OM_LUA_FORMAT.md)), gdzie opisane są też jeszcze nieznane konstrukcje.

- **Eksplorator urządzeń** (bez projektu): wykrywanie CLU, dołączanie do projektu (ustawienie
  klucza), sprawdzenie działania, restart, zmiana IP, odświeżenie modułów, moduły → wejścia/wyjścia
  z CONFIG.JSON, wartości na żywo z ustawianiem i wywoływaniem metod, pobieranie plików, pakiet
  diagnostyczny, konsola logów (telnet), pasek stanu.
- **Projekt jako tekst**: `opengr8on.yaml`, `clus/*.yaml`, `scripts/<CLU>/*.lua` w gicie
  ([format projektu](docs/PROJECT_FORMAT.md)); błędy w panelu Problems już w trakcie pisania.
- **Generowanie** OM.LUA / USER.LUA identycznych z tymi z Object Managera, **wysyłanie** przez TFTP
  ze sprawdzeniem po zapisie, **porównanie** z tym, co działa na CLU.
- **Import** projektu Object Managera (`.omp`) albo bieżącego OM.LUA z CLU.
- **Podpowiedzi Lua** z definicji urządzeń Grenton (LuaLS / sumneko.lua), notacja OM
  `CLU->OBIEKT->Cecha` z przyjaznymi nazwami, wykonanie zaznaczenia na CLU.
- **Interfejs po polsku i po angielsku** (zgodnie z językiem VS Code).

**Instrukcja obsługi (ze zrzutami ekranu): [docs/INSTRUKCJA.md](docs/INSTRUKCJA.md)** · przykładowy
projekt: [docs/demo](docs/demo)

Dokumentacja (po angielsku): [projekt](docs/DESIGN.md) · [format OM.LUA](docs/OM_LUA_FORMAT.md) ·
[format .omp](docs/OMP_FORMAT.md) · [format projektu](docs/PROJECT_FORMAT.md) ·
[odnośniki](docs/REFERENCES.md)

## Instalacja

1. Pobierz plik `opengr8on-vscode-X.Y.Z.vsix` z najnowszego wydania:
   **[Releases](https://github.com/psobiech/opengr8on-vscode/releases/latest)**.
2. W VS Code (≥ 1.85): widok **Rozszerzenia** (`Ctrl+Shift+X`) → menu `⋯` → **Zainstaluj z
   VSIX…** → wskaż pobrany plik. Albo z terminala:

   ```bash
   code --install-extension opengr8on-vscode-X.Y.Z.vsix
   ```

3. VS Code doinstaluje z Marketplace rozszerzenia z pakietu: **Lua** (`sumneko.lua`) i **YAML**
   (`redhat.vscode-yaml`). W VSCodium pochodzą z Open VSX — działa tak samo
   (`codium --install-extension …`).
4. Otwórz folder z plikiem `opengr8on.yaml` albo użyj polecenia **OpenGr8on: Nowy projekt** /
   **OpenGr8on: Importuj z Object Managera (.omp)** — dalej: [instrukcja](docs/INSTRUKCJA.md).

Aktualizacja: zainstaluj nowszy `.vsix` tak samo (zastępuje poprzednią wersję). Komputer musi być w
tej samej sieci co CLU (UDP/TFTP).

## Budowanie i pakowanie

### Wymagania

- Node.js ≥ 20 i npm
- git (biblioteka protokołu jest submodułem)
- VS Code ≥ 1.85 do uruchomienia

### Pobranie źródeł

```bash
git clone --recurse-submodules https://github.com/psobiech/opengr8on-vscode.git
cd opengr8on-vscode
# jeśli sklonowano bez submodułów:
git submodule update --init
npm install
```

`lib/opengr8on-node` to submoduł git ([opengr8on-node](https://github.com/psobiech/opengr8on-node),
gałąź `develop`). Jest używany jako źródła TypeScript przez wejście tylko-klienckie
`opengr8on-node/client` (zmapowane w `paths` w `tsconfig.json`, w `alias` esbuild i vitest), więc
jest pakowany razem z rozszerzeniem i nigdy nie budowany osobno. Aktualizacja:
`git submodule update --remote lib/opengr8on-node`.

### Budowanie

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/
npm test            # vitest
npm run watch       # przebudowa przy zmianach (używane przez F5)
```

`npm run build` (`esbuild.config.mjs`) tworzy:

| Wynik | Co to jest |
|---|---|
| `dist/extension.js` (+ `.map`) | jeden pakiet CommonJS (node20) z `src/extension.ts` i kodem klienckim opengr8on-node; `vscode` pozostaje zewnętrzny, brak natywnych zależności |
| `dist/interfaces/*.xml` | definicje interfejsów urządzeń (klasy CLU / modułów / obiektów) skopiowane z `lib/opengr8on-node/docs/device-interfaces` przez `scripts/copy-interfaces.mjs`; wczytywane w trakcie działania |

### Uruchomienie

Otwórz folder w VS Code i naciśnij **F5** („Run Extension”): uruchomi się okno Extension Development
Host z załadowanym rozszerzeniem. Rozszerzenie włącza się w folderze z plikiem `opengr8on.yaml` albo
po użyciu polecenia / widoku OpenGr8on.

### Pakiet (.vsix)

```bash
npm run build
npm run package -- -o opengr8on-vscode.vsix   # vsce package --no-dependencies
code --install-extension opengr8on-vscode.vsix
```

Wszystko, czego rozszerzenie potrzebuje w działaniu, jest już w pakiecie, stąd `--no-dependencies`
(bez `node_modules`). `.vscodeignore` wyklucza źródła, testy, dokumentację, submoduł i pliki
deweloperskie; pakiet zawiera `dist/extension.js`, `dist/interfaces/`, `schemas/`, `resources/`,
`package.json`, README i licencję (ok. 1,2 MB).

CI (`.github/workflows/ci.yml`) przy każdym pushu / pull requeście do `develop` i tagu `v*` sprawdza typy, buduje,
uruchamia testy i pakowanie, a plik `.vsix` udostępnia jako artefakt `opengr8on-vscode-vsix`.

### Wydanie

Wydanie publikuje job `release` w `.github/workflows/ci.yml` po wypchnięciu tagu:
`git tag vX.Y.Z && git push origin vX.Y.Z`. Wersję wyznacza tag (w CI wpisywana do `package.json`).
Workflow buduje, testuje i tworzy GitHub Release z `opengr8on-vscode-X.Y.Z.vsix` (+ `.sha256`). Wersja z sufiksem
(`0.2.0-rc.1`) trafia jako pre-release.

### Testy

`npm test` uruchamia testy jednostkowe i porównawcze („golden”: generowanie z oczyszczonych
prawdziwych plików OM w `tests/fixtures/`). `tests/unit/omp.acceptance.test.ts` dodatkowo porównuje
generator z prawdziwym projektem Object Managera, jeśli jest dostępny lokalnie
(`OPENGR8ON_OMP=/ścieżka/projekt.omp`, domyślnie `../opengr8on/runtime/project.omp`); w CI jest
pomijany. Gdy OM nie odświeżył zapisanej w projekcie kopii USER.LUA, rozbieżność można dopuścić przez
`OPENGR8ON_ALLOW_STALE_USER=1`.

Zrzuty ekranu do instrukcji powstają z `docs/demo`: `npm run build && node
scripts/docs/screenshots.mjs` (code-oss pod Xvfb, sterowany przez protokół DevTools; interfejs po
polsku, `SHOTS_LOCALE=en` dla angielskiego).

Tłumaczenia: teksty manifestu w `package.nls.json` / `package.nls.pl.json`, komunikaty w kodzie przez
`vscode.l10n.t` (albo `tr` z `src/i18n.ts` w modułach bez `vscode`), polskie wersje w
`l10n/bundle.l10n.pl.json`; `tests/unit/l10n.test.ts` wykrywa brakujące i nieaktualne tłumaczenia.

Prawdziwe pliki OM zawierają prywatne dane: dodawaj je do testów wyłącznie przez
`scripts/sanitize-om.mjs`, który podmienia numery seryjne / adresy IP / nazwy i odmawia zapisu
czegokolwiek, co wygląda na klucz (sposób użycia w nagłówku skryptu).

## Licencja

AGPL-3.0-or-later (zawiera [opengr8on-node](https://github.com/psobiech/opengr8on-node), AGPL).

## Zastrzeżenie prawne

Projekt nie jest popierany przez, bezpośrednio powiązany z, utrzymywany, autoryzowany ani sponsorowany
przez Grenton Sp. z o.o.

Użycie jakichkolwiek nazw handlowych lub znaków towarowych służy wyłącznie celom identyfikacyjnym
i referencyjnym i nie implikuje żadnego związku z właścicielem znaku towarowego ani jego marką
produktową.

Wszelkie nazwy produktów, logotypy, marki i inne znaki towarowe lub obrazy wymienione na tej stronie
stanowią własność ich odpowiednich właścicieli.

Korzystanie z tego oprogramowania może naruszać warunki gwarancji urządzeń Grenton. Użytkownik ponosi
wyłączną odpowiedzialność za ocenę zgodności z warunkami gwarancji producenta przed użyciem tego
oprogramowania z urządzeniami objętymi gwarancją.

Oprogramowanie jest dostarczane w stanie „takim, jaki jest” (as-is), bez jakichkolwiek gwarancji,
wyraźnych ani dorozumianych, w tym między innymi bez gwarancji przydatności handlowej, przydatności
do określonego celu ani nienaruszania praw osób trzecich. O ile wyraźnie nie zaznaczono inaczej,
osoba która powiązała utwór z niniejszą adnotacją nie udziela żadnych gwarancji dotyczących tego
utworu i zrzeka się odpowiedzialności za wszelkie sposoby jego użycia, w najszerszym zakresie
dopuszczalnym przez obowiązujące prawo.

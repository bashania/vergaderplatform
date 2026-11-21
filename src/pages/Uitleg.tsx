import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth, useUser } from "../auth";

function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="help-topic">
      <summary>{title}</summary>
      <div className="help-body">{children}</div>
    </details>
  );
}

/** Korte uitleg per rol: wat je met het platform doet en waar je het vindt. */
export default function UitlegPage() {
  const user = useUser();
  const { org, aiAvailable, mailEnabled } = useAuth();
  const admin = org?.role === "beheerder";
  const ai = !!aiAvailable && !!org?.aiEnabled;
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Uitleg</h1>
          <p className="lead">Wat je met het vergaderplatform doet en waar je het vindt. Klik een onderwerp open.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">In twee minuten</h2>
          <span className="muted small">Film met ondertitels, zonder geluid</span>
        </div>
        <div className="card-body">
          <video className="help-film" controls preload="none" playsInline poster="/instructiefilm.jpg" aria-label="Instructiefilm: van agenda tot afgeronde actie">
            <source src="/instructiefilm.mp4" type="video/mp4" />
          </video>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Voor iedereen die vergadert</h2>
        </div>
        <div className="card-body stack">
          <Topic title="Agenda en stukken lezen">
            <p>
              Op het <Link to="/">Overzicht</Link> staan je komende vergaderingen. Klik een vergadering aan voor de agenda; de stukken staan bij het
              agendapunt waar ze bij horen. Een pdf opent direct in je browser.{ai ? " Met de knop Samenvatting bij een stuk lees je eerst de kern." : ""}
            </p>
            <p>
              Geef bovenaan de vergadering aan of je erbij bent. De secretaris ziet dat op de presentielijst.
              {mailEnabled ? " In de e-mail met de agenda en in de herinnering kan dat ook, met één klik en zonder in te loggen." : ""}
            </p>
          </Topic>
          <Topic title="Vergaderingen in je eigen agenda">
            <p>
              Onder <Link to="/account">Mijn account</Link> maak je een agendalink. Voeg die één keer toe in Outlook, Google Agenda of je telefoon; daarna
              staan al je vergaderingen daar vanzelf in, ook als een datum verandert.
            </p>
          </Topic>
          <Topic title="Een onderwerp aandragen">
            <p>
              Open bij <Link to="/overleggen">Overleggen</Link> het overleg en klik op Punt aandragen. De secretaris zet je onderwerp op de agenda van een
              vergadering, of laat weten waarom niet. Je ziet daar ook wat er met je punt is gebeurd.
            </p>
          </Topic>
          <Topic title="Meelopen tijdens de vergadering">
            <p>
              Is de vergadering begonnen, dan staat er op het Overzicht en bij de vergadering een knop om mee te lopen. Je ziet steeds het punt dat aan de
              orde is, met de stukken erbij. Het scherm wisselt vanzelf mee. Zet de secretaris een stuk op het scherm, dan zie je dat stuk en dezelfde
              pagina.
            </p>
            <p>
              Staat er in de zaal een QR-code op het scherm, dan kun je ook zonder in te loggen meekijken: scan de code, of ga naar de pagina Meekijken en typ
              de code over. Je ziet dan de agenda, het punt dat aan de orde is en het stuk dat wordt getoond.
            </p>
          </Topic>
          <Topic title="Stemmen buiten de vergadering">
            <p>
              Soms kan een besluit niet wachten. De secretaris legt dan een voorstel voor in een stemronde. Je vindt hem op het Overzicht en bij het overleg,
              op het tabblad Stemrondes, en stemt met één klik: akkoord, niet akkoord of onthouding. Iedereen in het overleg ziet wie wat heeft gestemd.
            </p>
          </Topic>
          <Topic title="Je acties bijhouden">
            <p>
              Onder <Link to="/acties">Acties</Link> staat wat op jouw naam staat. Vink een actie af zodra die klaar is; dan klopt de actielijst van de
              volgende vergadering.{mailEnabled ? " Loopt een actie af, dan krijg je een e-mail. Dat zet je uit onder Mijn account." : ""}
            </p>
          </Topic>
          <Topic title="Terugvinden wat er is besloten">
            <p>
              De <Link to="/besluiten">Besluitenlijst</Link> bevat alle besluiten, genummerd per jaar. Met het zoekveld in het menu zoek je in agenda's,
              notulen, besluiten, acties en bestandsnamen.
              {ai ? " Op de zoekpagina kun je ook een vraag in gewone taal stellen; het antwoord noemt de besluiten en notulen waar het op steunt." : ""}
            </p>
          </Topic>
          <Topic title="Inloggen zonder wachtwoord">
            <p>
              Met een passkey log je in met je vingerafdruk, gezicht of de pincode van je apparaat. Je maakt er een aan onder{" "}
              <Link to="/account">Mijn account</Link>, het liefst op twee apparaten. Apparaat kwijt? Vraag de beheerder om een nieuwe link.
            </p>
          </Topic>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Voor de secretaris</h2>
        </div>
        <div className="card-body stack">
          <Topic title="Een vergadering voorbereiden">
            <ol>
              <li>Open het overleg en klik op Nieuwe vergadering. Neem de agenda over van de vorige keer, kies een standaardagenda of plak een bestaande agenda.</li>
              <li>Zet aangedragen punten met één klik op de agenda en voeg de stukken toe bij het juiste agendapunt.</li>
              <li>
                Publiceer. Pas dan zien de deelnemers de vergadering.{" "}
                {mailEnabled ? "Met Agenda mailen krijgt iedereen de agenda, een link naar de stukken en een agendabestand." : "Met Deelnemers mailen stuur je de link vanuit je eigen mailprogramma."}
              </li>
            </ol>
          </Topic>
          <Topic title="Tijdens de vergadering: de vergadermodus">
            <p>
              Klik bij de vergadering op Vergadermodus en start. Je ziet het actuele punt, de stukken en de klok. De notulen typ je erbij; ze worden vanzelf
              opgeslagen. Met Volgende ga je naar het volgende punt. Besluiten en acties leg je direct vast bij het punt.
            </p>
          </Topic>
          <Topic title="Een stuk tonen en laten meekijken">
            <ul>
              <li>
                <strong>Stuk op het scherm</strong>: klik in de vergadermodus bij een pdf of afbeelding op Op het scherm. Met de pijltjes blader je; wie
                meeloopt, ziet dezelfde pagina. Ga je naar het volgende agendapunt, dan gaat het stuk vanzelf van het scherm.
              </li>
              <li>
                <strong>Presentatiescherm</strong>: opent een tweede venster voor de beamer of het grote scherm, met de agenda, het actuele punt, de klok en
                het getoonde stuk. Je notulen staan daar niet op; die houd je in je eigen venster.
              </li>
              <li>
                <strong>Meekijken</strong>: zet het aan en er verschijnt een QR-code en een korte code, ook op het presentatiescherm. Aanwezigen en gasten
                kijken daarmee mee op hun eigen telefoon of laptop, zonder account. Ze zien alleen wat op het scherm staat: geen notulen, besluiten, acties
                of andere stukken. Het stopt als je de vergadermodus beëindigt, en het kan niet bij een besloten overleg.
              </li>
            </ul>
          </Topic>
          <Topic title="Na afloop: notulen, besluiten en acties">
            <ol>
              <li>Heb je de vergadering opgenomen? Zet het transcript bij de vergadering (uit Plaud, of als tekst uit Teams of Zoom).{ai ? " De AI-assistent maakt er concept-notulen per agendapunt van." : ""}</li>
              <li>{ai ? "Laat met Voorstellen uit notulen besluiten en acties voorstellen. Jij controleert en neemt over." : "Leg besluiten en acties vast bij het agendapunt."}</li>
              <li>Rond de vergadering af. Agenda, notulen en besluiten zijn dan vergrendeld{mailEnabled ? "; met Verslag mailen gaan de besluiten en acties naar de deelnemers" : ""}.</li>
              <li>Verwijder het transcript zodra de notulen zijn vastgesteld.</li>
            </ol>
          </Topic>
          <Topic title="Een besluit nemen zonder vergadering">
            <p>
              Open bij het overleg het tabblad Stemrondes en klik op Nieuwe stemronde. Formuleer het voorstel als het besluit dat je wilt nemen. Hebben
              genoeg deelnemers gestemd, dan sluit je de ronde en stel je de uitkomst vast. Een aangenomen voorstel leg je vast bij een vergadering; het
              krijgt dan een nummer en staat met de stemverhouding in de besluitenlijst.
            </p>
          </Topic>
          <Topic title="De volgende vergadering plannen">
            <p>
              Klik bij een vergadering op Volgende vergadering plannen. Datum, tijd, duur, plaats en agenda zijn dan al ingevuld, in het ritme van de vorige
              vergaderingen. Openstaande acties komen vanzelf terug op de actielijst.
            </p>
          </Topic>
        </div>
      </section>

      {(admin || user.isAdmin) && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Voor de beheerder</h2>
          </div>
          <div className="card-body stack">
            <Topic title="Mensen toegang geven">
              <p>
                Deelnemers voeg je toe bij het overleg zelf, op het tabblad Deelnemers, met hun e-mailadres. Onder{" "}
                <Link to="/organisatie">Toegang en beheer</Link> zie je iedereen met toegang en trek je toegang in. Mensen uit een andere organisatie zien niets
                van deze organisatie.
              </p>
            </Topic>
            <Topic title="Vertrouwelijke onderwerpen">
              <p>
                Wie deelneemt aan een overleg, ziet alles van dat overleg. Een beheerder van de organisatie ziet bovendien elk gewoon overleg. Moet een
                onderwerp in kleinere kring blijven (personeelszaken, een overname, het vooroverleg van de raad van toezicht zonder de bestuurder), gebruik dan
                een besloten overleg.
              </p>
              <ul>
                <li>
                  <strong>Besloten kring</strong>: de secretaris opent het overleg, tabblad Deelnemers, en kiest Besloten kring maken. Je kiest wie erin
                  zitten. De kring is een eigen overleg met eigen vergaderingen, stukken, besluiten en acties.
                </li>
                <li>
                  <strong>Bestaand overleg besloten maken</strong>: de secretaris kiest Bewerken en vinkt Besloten aan.
                </li>
                <li>
                  <strong>Wat een beheerder nog ziet</strong>: dat het overleg bestaat, hoe het heet en wie eraan deelneemt. Niet de agenda, stukken, notulen,
                  besluiten of acties. Kies dus een naam die zelf niets verraadt.
                </li>
              </ul>
              <p>
                De laatste secretaris van een besloten overleg kan zichzelf niet verwijderen: wijs eerst een andere aan. De platformbeheerder kan met de
                back-up van het platform bij alle gegevens; dat is de enige rol die niet buiten te sluiten is.
              </p>
            </Topic>
            <Topic title="Beveiliging en de AI-assistent">
              <p>
                Onder Toegang en beheer stel je een passkey verplicht voor vertrouwelijke overleggen en zet je de AI-assistent aan of uit. Staat de assistent
                aan, dan gaan notulen, stukken en transcripten waarop hij wordt gebruikt naar een taalmodel buiten het platform. Weeg dat af bij gevoelige
                stukken.
              </p>
            </Topic>
            <Topic title="Zien hoe het vergaderen loopt">
              <p>
                <Link to="/inzicht">Inzicht</Link> laat per overleg zien hoeveel er wordt vergaderd, of vergaderingen uitlopen en welk deel van de acties op
                tijd af is. Uitloop wordt gemeten in vergaderingen die met de vergadermodus zijn gehouden.
              </p>
            </Topic>
            {user.isAdmin && (
              <Topic title="E-mail instellen (platformbeheerder)">
                <p>
                  Onder <Link to="/beheer?tab=instellingen">Platformbeheer, Instellingen</Link> vul je de gegevens van een mailserver in en stuur je jezelf een
                  testmail. Daarna verstuurt het platform uitnodigingen, agenda's, verslagen en herinneringen. Zonder mailserver blijft alles werken; links
                  kopieer je dan zelf.
                </p>
                <p>
                  Met de Systeemcontrole op dezelfde pagina zie je in één keer of de database, de AI-assistent, de mailserver, Plaud en de dagelijkse
                  herinneringen werken, en in welke regio de gegevens staan. Die controle loopt ook elke ochtend vanzelf: werkt er iets niet, dan staat
                  er een stip bij Platformbeheer in het menu. Met Back-up download je alle gegevens als één bestand.
                </p>
              </Topic>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

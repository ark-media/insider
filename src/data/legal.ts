// Copy for the /privacy and /terms pages.
//
// The Privacy Policy and Terms of Service are Ark Media's final text (the
// "9.15.26 EJS rl" drafts), transcribed verbatim. A doc's `draft` flag drives
// the placeholder banner LegalPage renders above the content.
//
// Inline markup inside any string: `**bold**`; bare URLs and email addresses
// are linked automatically.

type ListItem = string | { text: string; items: string[] };

/** A paragraph, a subheading, or a bulleted list (one level of nesting). */
export type LegalBlock = string | { subheading: string } | { list: ListItem[] };

type LegalSection = { heading: string; body: LegalBlock[] };

export type LegalDoc = {
  title: string;
  lede: string;
  /** Shown as "Last updated {lastUpdated}". A calendar date (YYYY-MM-DD). */
  lastUpdated: string;
  draft: boolean;
  sections: LegalSection[];
};

export const PRIVACY: LegalDoc = {
  title: "Privacy Policy.",
  lede: "How Ark Media collects, uses, and protects your information.",
  lastUpdated: "2026-10-05",
  draft: false,
  sections: [
    {
      heading: "Introduction",
      body: [
        "This Privacy Policy describes Ark Media Podcast LLC’s policies and procedures on the collection, use and disclosure of Your information when You use our Website and associated services (collectively, “Services”) and tells You about Your privacy rights and how the law protects You.",
        "We use Your Personal data to provide and improve the Service. By using the Service, You agree to the collection and use of information in accordance with this Privacy Policy.",
      ],
    },
    {
      heading: "Interpretation",
      body: [
        "The words of which the initial letter is capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.",
      ],
    },
    {
      heading: "Definitions",
      body: [
        "For the purposes of this Privacy Policy:",
        {
          list: [
            "**Account:** means a unique account created for You to access our Service or parts of our Service.",
            "**Business:** for the purpose of the CCPA (California Consumer Privacy Act), refers to the Company as the legal entity that collects Consumers’ personal information and determines the purposes and means of the processing of Consumers’ personal information, or on behalf of which such information is collected and that alone, or jointly with others, determines the purposes and means of the processing of consumers’ personal information, that does business in the State of California.",
            "**Company** (referred to as either “the Company”, “We”, “Us” or “Our” in this Agreement): refers to Ark Media Podcast LLC, a Delaware limited liability company, which produces and distributes podcasts, newsletters and related subscription products.",
            "**Consumer:** for the purpose of the CCPA (California Consumer Privacy Act), means a natural person who is a California resident. A resident, as defined in the law, includes (1) every individual who is in the USA for other than a temporary or transitory purpose, and (2) every individual who is domiciled in the USA who is outside the USA for a temporary or transitory purpose.",
            "**Cookies:** are small files that are placed on Your computer, mobile device or any other device by a website, containing the details of Your browsing history on that website among its many uses.",
            "**Data Controller:** for the purposes of the GDPR (General Data Protection Regulation), refers to the Company as the legal person which alone or jointly with others determines the purposes and means of the processing of Personal Data.",
            "**Device:** means any device that can access the Service such as a computer, a cellphone or a digital tablet.",
            "**Do Not Track (DNT):** is a concept that has been promoted by US regulatory authorities, in particular the U.S. Federal Trade Commission (FTC), for the Internet industry to develop and implement a mechanism for allowing internet users to control the tracking of their online activities across websites.",
            "**Our /We:** means Ark Media Podcast LLC, the company whose Service You are accessing.",
            {
              text: "**Personal Data:** is any information that relates to an identified or identifiable individual.",
              items: [
                "For the purposes of GDPR, Personal Data means any information relating to You such as a name, an identification number, location data, online identifier or to one or more factors specific to the physical, physiological, genetic, mental, economic, cultural or social identity.",
                "For the purposes of the CCPA, Personal Data means any information that identifies, relates to, describes or is capable of being associated with, or could reasonably be linked, directly or indirectly, with You.",
              ],
            },
            "**Sale:** for the purpose of the CCPA (California Consumer Privacy Act), means selling, renting, releasing, disclosing, disseminating, making available, transferring, or otherwise communicating orally, in writing, or by electronic or other means, a Consumer’s personal information to another business or a third party for monetary or other valuable consideration.",
            "**Share:** for the purpose of the CCPA, means disclosing personal information to a third party for cross-context behavioral advertising, whether or not for money.",
            "**Sensitive Personal Information:** for the purpose of the CCPA, means the categories of personal information identified as sensitive under that law, including account log-in credentials in combination with a password.",
            "**Service:** refers to the Website.",
            "**Service Provider:** means any natural or legal person who processes the data on behalf of the Company. It refers to third-party companies or individuals employed by the Company to facilitate the Service, to provide the Service on behalf of the Company, to perform services related to the Service or to assist the Company in analyzing how the Service is used. For the purpose of the GDPR, Service Providers are considered Data Processors.",
            "**Usage Data:** refers to data collected automatically, either generated by the use of the Service or from the Service infrastructure itself (for example, the duration of a page visit).",
            "**Website:** means Ark Media’s websites and applications, including https://arkmedia.org and https://app.arkmedia.org, together with any successor or related properties.",
            "**Community:** means The Fold, the Ark Media online community made available to certain subscriptions, hosted on the Circle platform and accessible on the web and through a mobile app.",
            "**Newsletter:** means the Ark Media email newsletter delivered through Beehiiv, in both its free version and any version included with a subscription.",
            "**Private Podcast Feed:** means a subscriber-specific podcast feed URL issued to You as part of certain subscriptions.",
            "**You:** means the individual accessing or using the Service, or the company, or other legal entity on behalf of which such individual is accessing or using the Service, as applicable. Under GDPR (General Data Protection Regulation), You can be referred to as the Data Subject or as the User as You are the individual using the Service.",
          ],
        },
      ],
    },
    {
      heading: "Collecting and Using Your Personal Data",
      body: [
        { subheading: "Types of Data Collected" },
        { subheading: "Personal Data" },
        "While using Our Service, We may ask You to provide Us with certain personally identifiable information that can be used to contact or identify You. Personally identifiable information may include, but is not limited to:",
        {
          list: [
            "Email address",
            "First name and last name",
            "Phone number",
            "Address, State, Province, ZIP/Postal code, City",
            "Account and authentication identifiers, including the user identifier assigned by Our authentication provider and, if You sign in through a third-party identity provider, the information that provider shares with Us.",
            "Subscription and billing information, including the plan You purchased, the billing period, renewal and cancellation dates, and the last four digits and brand of Your payment card. Full payment card numbers are collected and held by Stripe, not by Us. If You purchase a subscription through a third-party platform, such as Apple Podcasts, that platform processes Your purchase and payment under its own privacy policy and does not share Your name, email address or payment information with Us; We generally receive only aggregated information, such as subscriber counts and listening statistics.",
            "Private Podcast Feed identifiers, which are unique to Your account and let Us deliver and revoke feed access.",
            "Newsletter engagement data, including whether an email was delivered, opened or clicked, and whether You unsubscribed.",
            "Community profile information and Community content, including Your display name, profile photo, biography, posts, comments, reactions and direct messages.",
            "Usage Data",
          ],
        },
        { subheading: "Usage Data" },
        {
          list: [
            "Usage Data is collected automatically when using the Service.",
            "Usage Data may include information such as Your Device’s Internet Protocol address (e.g. IP address), browser type, browser version, the pages of our Service that You visit, the time and date of Your visit, the time spent on those pages, unique device identifiers and other diagnostic data.",
            "When You access the Service by or through a mobile device, We may collect certain information automatically, including, but not limited to, the type of mobile device You use, Your mobile device unique ID, the IP address of Your mobile device, Your mobile operating system, the type of mobile Internet browser You use, unique device identifiers and other diagnostic data. If You use the Community mobile app, the app may also collect push-notification tokens and app diagnostic data. You can turn off push notifications in Your device settings.",
            "We may also collect information that Your browser sends whenever You visit our Service or when You access the Service by or through a mobile device.",
          ],
        },
        { subheading: "Tracking Technologies and Cookies" },
        "We use Cookies and similar tracking technologies to track the activity on Our Service and store certain information. Tracking technologies used are beacons, tags, and scripts to collect and track information and to improve and analyze Our Service. The technologies We use may include:",
        {
          list: [
            "**Cookies or Browser Cookies.** “Cookies” are data files that are placed on Your Device and often include an anonymous unique identifier. For more information about cookies, and how to disable cookies, visit http://www.allaboutcookies.org.",
            "**Web Beacons.** Certain sections of Our Service and Our emails may contain small electronic files known as web beacons (also referred to as clear gifs, pixel tags, and single-pixel gifs) that permit the Company, for example, to count users who have visited those pages or opened an email and for other related website statistics (for example, recording the popularity of a certain section and verifying system and server integrity).",
          ],
        },
      ],
    },
    {
      heading: "Use of Your Personal Data",
      body: [
        "The Company may use Personal Data for the following purposes:",
        {
          list: [
            "**To provide and maintain Our Service,** including to monitor the usage of Our Service.",
            "**To manage Your Account:** to manage Your registration as a user of the Service. The Personal Data You provide can give You access to different functionalities of the Service that are available to You as a registered user.",
            "**For the performance of a contract:** the development, compliance and undertaking of the purchase contract for the products, items or services You have purchased or of any other contract with Us through the Service.",
            "**To contact You:** To contact You by email, telephone calls, SMS, or other equivalent forms of electronic communication, such as mobile application’s push notifications regarding updates or informative communications related to the functionalities, products or contracted services, including the security updates, when necessary or reasonable for their implementation.",
            "**To provide You** with news, special offers and general information about other products, services and events which we offer that are similar to those that You have already purchased or enquired about unless You have opted not to receive such information.",
            "**To manage Your requests:** To attend and manage Your requests to Us.",
            "**For business transfers:** We may use Your information to evaluate or conduct a merger, divestiture, restructuring, reorganization, dissolution, or other sale or transfer of some or all of Our assets, whether as a going concern or as part of bankruptcy, liquidation, or similar proceeding, in which Personal Data held by Us about our Service users is among the assets transferred.",
            "**For other purposes:** We may use Your information for other purposes, such as data analysis, identifying usage trends, determining the effectiveness of Our promotional campaigns and to evaluate and improve Our Service, products, services, marketing and your experience.",
            "To deliver the Newsletter, and to enroll You in it when You purchase a subscription through the Website.",
            "To issue, deliver and revoke Private Podcast Feed access.",
            "To operate the Community, including displaying Your profile and content to other members and enforcing the Community Guidelines.",
            "To authenticate You and secure Your account.",
            "To send transactional and service messages, including receipts, renewal reminders, cancellation confirmations and security notices.",
          ],
        },
        "We may share Your personal information in the following situations:",
        {
          list: [
            "**With Service Providers:** We may share Your personal information with Service Providers to monitor and analyze the use of Our Service, for payment processing, to contact You.",
            "**For business transfers:** We may share or transfer Your personal information in connection with, or during negotiations of, any merger, sale of Company assets, financing, or acquisition of all or a portion of Our business to another company.",
            "**With Affiliates:** We may share Your information with Our affiliates, in which case we will require those affiliates to honor this Privacy Policy. Affiliates include Our parent company and any other subsidiaries, joint venture partners or other companies that We control or that are under common control with Us.",
            "**With other users:** when You post or interact in the Community or in another public or semi-public area of the Service, Your display name, profile photo and the content You post can be seen by other members, and members may be able to copy or share it outside the Service.",
            "**With Your consent:** We may disclose Your personal information for any other purpose with Your consent.",
          ],
        },
      ],
    },
    {
      heading: "Service Providers We Use",
      body: [
        "We use the following service providers to operate the Service. Each processes personal information on Our behalf and under contract, and each has its own privacy policy:",
        {
          list: [
            "**Beehiiv** — delivery of the Newsletter and the Private Podcast Feeds. https://www.beehiiv.com/privacy",
            "**Circle** — hosting of the Community and its mobile app. https://circle.so/privacy",
            "**Auth0** — account authentication and login. https://www.okta.com/privacy-policy/",
            "**Stripe** — payment processing. https://stripe.com/privacy",
            "**Google Analytics** — website analytics. https://policies.google.com/privacy",
          ],
        },
        "We do not authorize these providers to use Your personal information for their own marketing purposes.",
        "Circle may also use certain data about how its platform is used for its own purposes, such as operating and improving the platform, as described in Circle’s privacy policy. That use is governed by Circle’s privacy policy, not this one.",
      ],
    },
    {
      heading: "Retention of Your Personal Data",
      body: [
        "The Company will retain Your Personal Data only for as long as is necessary for the purposes set out in this Privacy Policy. We will retain and use Your Personal Data to the extent necessary to comply with Our legal obligations (for example, if we are required to retain Your data to comply with applicable laws), resolve disputes, and enforce Our legal agreements and policies.",
        "The Company will also retain Usage Data for internal analysis purposes. Usage Data is generally retained for a shorter period of time, except when this data is used to strengthen the security or to improve the functionality of Our Service, or We are legally obligated to retain this data for longer time periods.",
        "The periods We generally apply are:",
        {
          list: [
            "Account and subscription records: for as long as Your account is open, and for seven (7) years after it closes, to meet tax, accounting and audit obligations.",
            "Payment records held by Stripe: as required by Stripe and by applicable tax law.",
            "Newsletter subscription and engagement records: for as long as You are subscribed, and for up to twenty-four (24) months after You unsubscribe, so that We can honor Your unsubscribe request.",
            "Community profile and content: for as long as Your Community account exists. If Your Community account is deactivated, Your profile is hidden but Your account record is kept, and Your posts, comments and messages remain visible to other members with Your name attached. If Your Community account is deleted, Your profile and all of Your posts, comments and messages are permanently erased and no longer appear in threads. Deleted information is removed from Circle’s backups as those backups are overwritten in the ordinary course.",
            "Website Usage Data and analytics: up to twenty-six (26) months. Activity within the Community is kept with Your Community account, as described above.",
            "Records of privacy requests: as long as required to demonstrate Our compliance, generally twenty-four (24) months.",
          ],
        },
        "Where a longer period is required by law, or where information is needed to establish, exercise or defend a legal claim, We retain it for that longer period.",
      ],
    },
    {
      heading: "Transfer of Your Personal Data",
      body: [
        "Your information, including Personal Data, may be processed at the Company’s main offices or in any other locations where the parties involved in the processing operate. As a result, your information may be transferred to and stored on servers located outside your state, province, country, or other governmental jurisdiction where data protection laws may differ from those in your own jurisdiction.",
        "Your consent to this Privacy Policy followed by Your submission of such information represents Your agreement to that transfer.",
        "The Company will take all steps reasonably necessary to ensure that Your data is treated securely and in accordance with this Privacy Policy and no transfer of Your Personal Data will take place to an organization or a country unless there are adequate controls in place including the security of Your data and other personal information.",
      ],
    },
    {
      heading: "Delete Your Personal Data",
      body: [
        "You have the right to delete or request that We assist in deleting the Personal Data that We have collected about You.",
        "Our Service may give You the ability to delete certain information about You from within the Service.",
        "You may update, amend, or delete Your information at any time by signing in to Your Account, if you have one, and visiting the account settings section that allows You to manage Your personal information. You may also contact Us to request access to, correct, or delete any personal information that You have provided to Us.",
        "Please note, however, that We may need to retain certain information when we have a legal obligation or lawful basis to do so.",
        "Because We use service providers, a deletion request is passed to them as well. Deleting Your account removes Your login from Our authentication provider, permanently deletes Your Community profile and everything You posted in the Community, unsubscribes You from the Newsletter and revokes Your Private Podcast Feed URLs. Transaction records held by Our payment processor are retained where tax and accounting law requires it. If Your Community account is deactivated rather than deleted, what You posted remains visible to other members, as described above. Ark Media, not Circle, is responsible for Community data. Send any request to access, correct or delete Community data to Us at hello@arkmedia.org; if You send it to Circle, Circle will forward it to Us.",
      ],
    },
    {
      heading: "Disclosure of Your Personal Data",
      body: [
        { subheading: "Business Transactions" },
        "If the Company is involved in a merger, acquisition or asset sale, Your Personal Data may be transferred. We will provide notice before Your Personal Data is transferred and becomes subject to a different Privacy Policy.",
        { subheading: "Law enforcement" },
        "Under certain circumstances, the Company may be required to disclose Your Personal Data if required to do so by law or in response to valid requests by public authorities (e.g. a court or a government agency).",
        { subheading: "Other legal requirements" },
        "The Company may disclose Your Personal Data in the good faith belief that such action is necessary to:",
        {
          list: [
            "Comply with a legal obligation",
            "Protect and defend the rights or property of the Company",
            "Prevent or investigate possible wrongdoing in connection with the Service",
            "Protect the personal safety of Users of the Service or the public",
            "Protect against legal liability",
          ],
        },
      ],
    },
    {
      heading: "Security of Your Personal Data",
      body: [
        "The security of Your Personal Data is important to Us, but remember that no method of transmission over the Internet, or method of electronic storage is 100% secure. While We strive to use commercially acceptable means to protect Your Personal Data, We cannot guarantee its absolute security.",
      ],
    },
    {
      heading: "Detailed Information on the Processing of Your Personal Data",
      body: [
        "The Service Providers We use may have access to Your Personal Data. These third-party vendors collect, store, use, process and transfer information about Your activity on Our Service in accordance with their Privacy Policies.",
        { subheading: "Analytics" },
        "We may use third-party Service providers to monitor and analyze the use of Our Service.",
        "**Google Analytics:** Google Analytics is a web analytics service offered by Google that tracks and reports website traffic. Google uses the data collected to track and monitor the use of Our Service. This data is shared with other Google services. Google may use the collected data to contextualize and personalize the ads of its own advertising network. You can opt-out of having made Your activity on the Service available to Google Analytics by installing the Google Analytics opt-out browser add-on. The add-on prevents the Google Analytics JavaScript (ga.js, analytics.js and dc.js) from sharing information with Google Analytics about visits activity. For more information on the privacy practices of Google, please visit the Google Privacy & Terms web page: https://policies.google.com/privacy.",
        { subheading: "Email Marketing" },
        "We may use Your Personal Data to contact You with newsletters, marketing or promotional materials and other information that may be of interest to You. You may opt-out of receiving any, or all, of these communications from Us by following the unsubscribe link or instructions provided in any email We send or by contacting Us. We may use Email Marketing Service Providers to manage and send emails to You.",
        "When You purchase a subscription through the Website, We enroll You in the Newsletter, which is included with every such subscription. You may unsubscribe at any time using the unsubscribe link in any Newsletter email or by contacting Us at hello@arkmedia.org. Unsubscribing does not cancel Your subscription. If You purchase a subscription through a third-party platform, such as Apple Podcasts, We do not receive Your email address and cannot enroll You, but You may sign up for the Newsletter directly. Anyone may also sign up for its free version.",
        "Unsubscribing from the Newsletter does not stop transactional and service messages. We will continue to send receipts, renewal and cancellation notices, Private Podcast Feed links and account and security notices for as long as You hold an account, because those messages are necessary to provide the Service.",
        "If You are located in the European Economic Area, the United Kingdom, Switzerland or Israel, We will give You the opportunity to decline the Newsletter when You purchase a subscription, and We will not enroll You if You decline.",
        { subheading: "Payments" },
        "We may provide paid products and/or services within the Service. In that case, we may use third-party services for payment processing (e.g. payment processors).",
        "We will not store or collect Your payment card details. That information is provided directly to Our third-party payment processors whose use of Your personal information is governed by their Privacy Policy. These payment processors adhere to the standards set by PCI-DSS as managed by the PCI Security Standards Council, which is a joint effort of brands like Visa, Mastercard, American Express and Discover. PCI-DSS requirements help ensure the secure handling of payment information.",
        "**Stripe:** Their Privacy Policy can be viewed at: https://stripe.com/us/privacy",
        { subheading: "Beehiiv" },
        "We use Beehiiv to deliver the Newsletter and the Private Podcast Feeds. Their Privacy Policy can be viewed at: https://www.beehiiv.com/privacy",
        { subheading: "Circle" },
        "We use Circle to host the Community. Their Privacy Policy can be viewed at: https://circle.so/privacy",
        { subheading: "Auth0" },
        "We use Auth0 to authenticate Your account and manage login. Their Privacy Policy can be viewed at: https://www.okta.com/privacy-policy/",
      ],
    },
    {
      heading: "Legal Basis for Processing Personal Data under GDPR",
      body: [
        "We may process Personal Data under the following conditions:",
        {
          list: [
            "**Consent:** You have given Your consent for processing Personal Data for one or more specific purposes.",
            "**Performance of a contract:** Provision of Personal Data is necessary for the performance of an agreement with You and/or for any pre-contractual obligations thereof.",
            "**Legal obligations:** Processing Personal Data is necessary for compliance with a legal obligation to which the Company is subject.",
            "**Vital interests:** Processing Personal Data is necessary in order to protect Your vital interests or of another natural person.",
            "**Public interests:** Processing Personal Data is related to a task that is carried out in the public interest or in the exercise of official authority vested in the Company.",
            "**Legitimate interests:** Processing Personal Data is necessary for the purposes of the legitimate interests pursued by the Company.",
          ],
        },
        "In any case, the Company will gladly help to clarify the specific legal basis that applies to the processing, and in particular whether the provision of Personal Data is a statutory or contractual requirement, or a requirement necessary to enter into a contract.",
      ],
    },
    {
      heading: "Your Rights under the GDPR",
      body: [
        "The Company undertakes to respect the confidentiality of Your Personal Data and to guarantee You can exercise Your rights. You have the right under this Privacy Policy, and by law if You are within the EU, to:",
        {
          list: [
            "**Request access to Your Personal Data.** The right to access, update or delete the information We have on You. Whenever made possible, you can access, update or request deletion of Your Personal Data directly within Your account settings section. If you are unable to perform these actions yourself, please contact Us to assist You. This also enables You to receive a copy of the Personal Data We hold about You.",
            "**Request correction of the Personal Data that We hold about You.** You have the right to have any incomplete or inaccurate information We hold about You corrected.",
            "**Object to processing of Your Personal Data.** This right exists where We are relying on a legitimate interest as the legal basis for Our processing and there is something about Your particular situation, which makes You want to object to Our processing of Your Personal Data on this ground. You also have the right to object where We are processing Your Personal Data for direct marketing purposes.",
            "**Request erasure of Your Personal Data.** You have the right to ask Us to delete or remove Personal Data when there is no good reason for Us to continue processing it.",
            "**Request the transfer of Your Personal Data.** We will provide to You, or to a third-party You have chosen, Your Personal Data in a structured, commonly used, machine-readable format. Please note that this right only applies to automated information which You initially provided consent for Us to use or where We used the information to perform a contract with You.",
            "**Withdraw Your consent.** You have the right to withdraw Your consent on using your Personal Data. If You withdraw Your consent, We may not be able to provide You with access to certain specific functionalities of the Service.",
          ],
        },
      ],
    },
    {
      heading: "Exercising of Your GDPR Data Protection Rights",
      body: [
        "You may exercise Your rights of access, rectification, cancellation and opposition by contacting Us. Please note that we may ask You to verify Your identity before responding to such requests. If You make a request, We will try Our best to respond to You as soon as possible. You have the right to complain to a Data Protection Authority about Our collection and use of Your Personal Data. For more information, if You are in the European Economic Area (EEA), please contact Your local data protection authority in the EEA.",
      ],
    },
    {
      heading: "California Privacy Rights (CCPA/CPRA)",
      body: [
        "This privacy notice section for California residents supplements the information contained in Our Privacy Policy and it applies solely to all visitors, users, and others who reside in the State of California.",
        { subheading: "Categories of Personal Information Collected" },
        "We collect information that identifies, relates to, describes, references, is capable of being associated with, or could reasonably be linked, directly or indirectly, with a particular Consumer or Device. The following is a list of categories of personal information which we may collect or may have been collected from California residents within the last twelve (12) months.",
        "Please note that the categories and examples provided in the list below are those defined in the CCPA. This does not mean that all examples of that category of personal information were in fact collected by Us, but reflects Our good faith belief to the best of Our knowledge that some of that information from the applicable category may be and may have been collected. For example, certain categories of personal information would only be collected if You provided such personal information directly to Us.",
        {
          list: [
            {
              text: "**Category A: Identifiers.**",
              items: [
                "Examples: A real name, alias, postal address, unique personal identifier, online identifier, Internet Protocol address, email address, account name, driver’s license number, passport number, or other similar identifiers.",
                "Collected: Yes.",
              ],
            },
            {
              text: "**Category B: Personal information categories listed in the California Customer Records statute (Cal. Civ. Code § 1798.80(e)).**",
              items: [
                "Examples: A name, signature, Social Security number, physical characteristics or description, address, telephone number, passport number, driver’s license or state identification card number, insurance policy number, education, employment, employment history, bank account number, credit card number, debit card number, or any other financial information, medical information, or health insurance information. Some personal information included in this category may overlap with other categories.",
                "Collected: Yes.",
              ],
            },
            {
              text: "**Category C: Protected classification characteristics under California or federal law.**",
              items: [
                "Examples: Age (40 years or older), race, color, ancestry, national origin, citizenship, religion or creed, marital status, medical condition, physical or mental disability, sex (including gender, gender identity, gender expression, pregnancy or childbirth and related medical conditions), sexual orientation, veteran or military status, genetic information (including familial genetic information).",
                "Collected: No.",
              ],
            },
            {
              text: "**Category D: Commercial information.**",
              items: [
                "Examples: Records and history of products or services purchased or considered.",
                "Collected: Yes.",
              ],
            },
            {
              text: "**Category E: Biometric information.**",
              items: [
                "Examples: Genetic, physiological, behavioral, and biological characteristics, or activity patterns used to extract a template or other identifier or identifying information, such as, fingerprints, faceprints, and voiceprints, iris or retina scans, keystroke, gait, or other physical patterns, and sleep, health, or exercise data.",
                "Collected: No.",
              ],
            },
            {
              text: "**Category F: Internet or other similar network activity.**",
              items: [
                "Examples: Interaction with Our Service or advertisement.",
                "Collected: Yes.",
              ],
            },
            {
              text: "**Category G: Geolocation data.**",
              items: [
                "Examples: Approximate physical location.",
                "Collected: No.",
              ],
            },
            {
              text: "**Category H: Sensory data.**",
              items: [
                "Examples: Audio, electronic, visual, thermal, olfactory, or similar information.",
                "Collected: No.",
              ],
            },
            {
              text: "**Category I: Professional or employment-related information.**",
              items: [
                "Examples: Current or past job history or performance evaluations.",
                "Collected: No.",
              ],
            },
            {
              text: "**Category J: Non-public education information (per the Family Educational Rights and Privacy Act (20 U.S.C. Section 1232g, 34 C.F.R. Part 99)).**",
              items: [
                "Examples: Education records directly related to a student maintained by an educational institution or party acting on its behalf, such as grades, transcripts, class lists, student schedules, student identification codes, student financial information, or student disciplinary records.",
                "Collected: No.",
              ],
            },
            {
              text: "**Category K: Inferences drawn from other personal information.**",
              items: [
                "Examples: Profile reflecting a person’s preferences, characteristics, psychological trends, predispositions, behavior, attitudes, intelligence, abilities, and aptitudes.",
                "Collected: No.",
              ],
            },
          ],
        },
        "Under CCPA, personal information does not include:",
        {
          list: [
            "Publicly available information from government records.",
            "Deidentified or aggregated consumer information.",
            {
              text: "Information excluded from the CCPA’s scope, such as:",
              items: [
                "Health or medical information covered by the Health Insurance Portability and Accountability Act of 1996 (HIPAA) and the California Confidentiality of Medical Information Act (CMIA) or clinical trial data.",
                "Personal Information covered by certain sector-specific privacy laws, including the Fair Credit Reporting Act (FRCA), the Gramm-Leach-Bliley Act (GLBA) or California Financial Information Privacy Act (FIPA), and the Driver’s Privacy Protection Act of 1994.",
              ],
            },
          ],
        },
        { subheading: "Sources of Personal Information" },
        "We obtain the categories of personal information listed above from the following categories of sources:",
        {
          list: [
            "**Directly from You.** For example, from the forms You complete on Our Service, preferences You express or provide through Our Service, or from Your purchases on our Service.",
            "**Indirectly from You.** For example, from observing Your activity on our Service.",
            "**Automatically from You.** For example, through cookies We or Our Service Providers set on Your Device as You navigate through Our Service.",
            "**From Service Providers.** For example, third-party vendors to monitor and analyze the use of our Service, third-party vendors for payment processing, or other third-party vendors that We use to provide the Service to You.",
          ],
        },
        {
          subheading:
            "Use of Personal Information for Business Purposes or Commercial Purposes",
        },
        "We may use or disclose personal information We collect for “business purposes” or “commercial purposes” (as defined under the CCPA), which may include the following examples:",
        {
          list: [
            "To operate Our Service and provide You with Our Service.",
            "To provide You with support and to respond to Your inquiries, including to investigate and address Your concerns and monitor and improve Our Service.",
            "To fulfill or meet the reason You provided the information. For example, if You share Your contact information to ask a question about Our Service, We will use that personal information to respond to Your inquiry. If You provide Your personal information to purchase a product or service, We will use that information to process Your payment and facilitate delivery.",
            "To respond to law enforcement requests and as required by applicable law, court order, or governmental regulations.",
            "As described to You when collecting Your personal information or as otherwise set forth in the CCPA.",
            "For internal administrative and auditing purposes.",
            "To detect security incidents and protect against malicious, deceptive, fraudulent or illegal activity, including, when necessary, to prosecute those responsible for such activities.",
          ],
        },
        "Please note that the examples provided above are illustrative and not intended to be exhaustive. For more details on how we use this information, please refer to the “Use of Your Personal Data” section.",
        "If We decide to collect additional categories of personal information or use the personal information We collected for materially different, unrelated, or incompatible purposes We will update this Privacy Policy.",
        {
          subheading:
            "Disclosure of Personal Information for Business Purposes or Commercial Purposes",
        },
        "We may use or disclose and may have used or disclosed in the last twelve (12) months the following categories of personal information for business or commercial purposes:",
        {
          list: [
            "Category A: Identifiers",
            "Category B: Personal information categories listed in the California Customer Records statute (Cal. Civ. Code § 1798.80(e))",
            "Category D: Commercial information",
            "Category F: Internet or other similar network activity",
          ],
        },
        "Please note that the categories listed above are those defined in the CCPA. This does not mean that all examples of that category of personal information were in fact disclosed, but reflects Our good faith belief to the best of Our knowledge that some of that information from the applicable category may be and may have been disclosed.",
        "When We disclose personal information for a business purpose or a commercial purpose, We enter a contract that describes the purpose and requires the recipient to both keep that personal information confidential and not use it for any purpose except performing the contract.",
        { subheading: "Sale and Sharing of Personal Information" },
        "As defined in the CCPA, “sell” and “sale” mean selling, renting, releasing, disclosing, disseminating, making available, transferring, or otherwise communicating orally, in writing, or by electronic or other means, a consumer’s personal information by the business to a third party for valuable consideration. This means that We may receive some kind of benefit in return for sharing personal information, but not necessarily a monetary benefit.",
        "We do not sell Your personal information, and We do not share Your personal information for cross-context behavioral advertising, as those terms are defined by the CCPA. We have not sold or shared personal information in the preceding twelve (12) months.",
        "We do not collect or process Sensitive Personal Information for the purpose of inferring characteristics about You, and We use it only as necessary to provide the Service.",
        { subheading: "Share of Personal Information" },
        "We may share Your personal information identified in the above categories with the following categories of third parties:",
        {
          list: [
            "Service Providers",
            "Payment processors",
            "Our affiliates",
            "Our business partners",
            "Third party vendors to whom You or Your agents authorize Us to disclose Your personal information in connection with products or services We provide to You.",
          ],
        },
        { subheading: "Minors" },
        "The Service is intended for adults. Our Terms of Service require account holders to be at least 18 years old, and We do not knowingly collect personal information from anyone under 18. If We learn that We have collected information from someone under 18, We will close the account and delete the information.",
        "If You believe a person under 18 has provided Us with personal information, please contact Us with enough detail for Us to identify and delete it.",
        { subheading: "Your Rights under the CCPA" },
        "The CCPA provides California residents with specific rights regarding their personal information.",
        "If You are a resident of California, You have the following rights:",
        {
          list: [
            "**The right to notice.** You have the right to be notified which categories of Personal Data are being collected and the purposes for which the Personal Data is being used.",
            {
              text: "**The right to request.** Under CCPA, You have the right to request that We disclose information to You about Our collection, use, sale, disclosure for business purposes and share of personal information. Once We receive and confirm Your request, We will disclose to You:",
              items: [
                "The categories of personal information We collected about You",
                "The categories of sources for the personal information We collected about You",
                "Our business or commercial purpose for collecting or selling that personal information",
                "The categories of third parties with whom We share that personal information",
                "The specific pieces of personal information We collected about You",
                "If we sold Your personal information or disclosed Your personal information for a business purpose, We will disclose to You:",
                "The categories of personal information categories sold",
                "The categories of personal information categories disclosed",
              ],
            },
            "**The right to opt out of the sale or sharing of Personal Data.** You have the right to direct Us not to sell Your personal information or share it for cross-context behavioral advertising. As stated above, We do not do either.",
            {
              text: "**The right to delete Personal Data.** You have the right to request the deletion of Your Personal Data, subject to certain exceptions. Once We receive and confirm Your request, We will delete (and direct Our Service Providers to delete) Your personal information from Our records, unless an exception applies. We may deny Your deletion request if retaining the information is necessary for Us or Our Service Providers to:",
              items: [
                "Complete the transaction for which We collected the personal information, provide a good or service that You requested, take actions reasonably anticipated within the context of Our ongoing business relationship with You, or otherwise perform Our contract with You.",
                "Detect security incidents, protect against malicious, deceptive, fraudulent, or illegal activity, or prosecute those responsible for such activities.",
                "Debug products to identify and repair errors that impair existing intended functionality.",
                "Exercise free speech, ensure the right of another consumer to exercise their free speech rights, or exercise another right provided for by law.",
                "Comply with the California Electronic Communications Privacy Act (Cal. Penal Code § 1546 et. seq.).",
                "Engage in public or peer-reviewed scientific, historical, or statistical research in the public interest that adheres to all other applicable ethics and privacy laws, when the information’s deletion may likely render impossible or seriously impair the research’s achievement, if You previously provided informed consent.",
                "Enable solely internal uses that are reasonably aligned with consumer expectations based on Your relationship with Us.",
                "Comply with a legal obligation.",
                "Make other internal and lawful uses of that information that are compatible with the context in which You provided it.",
              ],
            },
            {
              text: "**The right not to be discriminated against.** You have the right not to be discriminated against for exercising any of Your consumer’s rights, including by:",
              items: [
                "Denying goods or services to You.",
                "Charging different prices or rates for goods or services, including the use of discounts or other benefits or imposing penalties.",
                "Providing a different level or quality of goods or services to You.",
                "Suggesting that You will receive a different price or rate for goods or services or a different level or quality of goods or services.",
              ],
            },
            "**The right to correct.** You have the right to ask Us to correct inaccurate personal information We hold about You.",
            "**The right to limit the use of Sensitive Personal Information.** Where We use Sensitive Personal Information for purposes beyond providing the Service, You have the right to direct Us to limit that use.",
            "**The right to opt out of automated decision-making and profiling,** to the extent We engage in it. We do not currently use Your personal information to make automated decisions that produce legal or similarly significant effects.",
          ],
        },
        { subheading: "Exercising Your CCPA Data Protection Rights" },
        "In order to exercise any of Your rights under the CCPA, and if You are a California resident, You can contact Us:",
        { list: ["By email: hello@arkmedia.org"] },
        "Only You, or a person registered with the California Secretary of State that You authorize to act on Your behalf, may make a verifiable request related to Your personal information.",
        "Your request to Us must:",
        {
          list: [
            "Provide sufficient information that allows Us to reasonably verify You are the person about whom We collected personal information or an authorized representative",
            "Describe Your request with sufficient detail that allows Us to properly understand, evaluate, and respond to it",
          ],
        },
        "We cannot respond to Your request or provide You with the required information if We cannot:",
        {
          list: [
            "Verify Your identity or authority to make the request",
            "And confirm that the personal information relates to You",
          ],
        },
        "We will disclose and deliver the required information free of charge within 45 days of receiving Your verifiable request. The time period to provide the required information may be extended once by an additional 45 days when reasonably necessary and with prior notice. Any disclosures We provide will only cover the 12-month period preceding the verifiable request’s receipt. For data portability requests, We will select a format to provide Your personal information that is readily usable and should allow You to transmit the information from one entity to another entity without hindrance.",
        { subheading: "Data Access Rights" },
        "To the extent applicable law provides You with the right to review, correct, update, or delete Personal Information that You previously have provided to us, please contact Us using Our contact information below should You wish to do so. We will respond to Your request consistent with applicable law.",
      ],
    },
    {
      heading: "Do Not Sell or Share My Personal Information",
      body: [
        "We do not sell or share Your personal information. If that ever changes, We will update this Privacy Policy, post a “Do Not Sell or Share My Personal Information” link on Our homepage, and honor opt-out requests submitted through it.",
        "We honor opt-out preference signals, including the Global Privacy Control, transmitted by Your browser or device, and We treat such a signal as a valid request to opt out for that browser or device.",
        "The Service Providers we partner with (for example, Our analytics or advertising partners) may use technology on the Service that sells personal information as defined by the CCPA law. If you wish to opt out of the use of Your personal information for interest-based advertising purposes and these potential sales as defined under CCPA law, You may do so by following the instructions below.",
        "Please note that any opt out is specific to the browser You use. You may need to opt out on every browser that You use.",
        { subheading: "Website" },
        "You can opt out of receiving ads that are personalized as served by Our Service Providers by following Our instructions presented on the Service:",
        {
          list: [
            "The NAI’s opt-out platform: http://www.networkadvertising.org/choices/",
            "The EDAA’s opt-out platform http://www.youronlinechoices.com/",
            "The DAA’s opt-out platform: http://optout.aboutads.info/?c=2&lang=EN",
          ],
        },
        "The opt out will place a cookie on Your computer that is unique to the browser You use to opt out. If You change browsers or delete the cookies saved by Your browser, You will need to opt out again.",
        { subheading: "Mobile Devices" },
        "Your mobile device may give You the ability to opt out of the use of information about the apps You use in order to serve You ads that are targeted to Your interests:",
        {
          list: [
            "“Opt out of Interest-Based Ads” or “Opt out of Ads Personalization” on Android devices",
            "“Limit Ad Tracking” on iOS devices",
          ],
        },
        "You can also stop the collection of location information from Your mobile device by changing the preferences on Your mobile device.",
      ],
    },
    {
      heading:
        "“Do Not Track” Policy as Required by California Online Privacy Protection Act (CalOPPA)",
      body: [
        "Our Service does not respond to Do Not Track signals, which are distinct from the opt-out preference signals described above. We do honor the Global Privacy Control. However, some third party websites do keep track of Your browsing activities. If You are visiting such websites, You can set Your preferences in Your web browser to inform websites that You do not want to be tracked. You can enable or disable DNT by visiting the preferences or settings page of Your web browser.",
      ],
    },
    {
      heading: "Children’s Privacy",
      body: [
        "Our Service is not directed to anyone under 18, and We do not knowingly collect personally identifiable information from anyone under 18. If You are a parent or guardian and You believe Your child has provided Us with Personal Data, please contact Us. If We become aware that We have collected Personal Data from anyone under 18, We take steps to remove that information from Our servers.",
      ],
    },
    {
      heading:
        "Your California Privacy Rights (California’s Shine the Light law)",
      body: [
        "Under California Civil Code Section 1798 (California’s Shine the Light law), California residents with an established business relationship with us can request information once a year about sharing their Personal Data with third parties for the third parties’ direct marketing purposes. If You’d like to request more information under the California Shine the Light law, and if You are a California resident, You can contact Us using the contact information provided below.",
      ],
    },
    {
      heading: "Privacy Rights in Other States",
      body: [
        "If You live in a state with a comprehensive consumer privacy law, including Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, Delaware, New Jersey and others as they take effect, You may have the right to confirm whether We process Your personal data, to access it, to correct it, to delete it, to obtain a portable copy, and to opt out of targeted advertising, the sale of personal data and certain profiling.",
        "To exercise any of these rights, contact Us at hello@arkmedia.org. We will respond within the period required by Your state’s law. If We decline Your request, You may appeal by replying to Our response; We will inform You in writing of the outcome of the appeal and, where required, how to contact Your state attorney general.",
      ],
    },
    {
      heading:
        "California Privacy Rights for Minor Users (California Business and Professions Code Section 22581)",
      body: [
        "California Business and Professions Code Section 22581 allows California residents under the age of 18 who are registered users of online sites, services or applications to request and obtain removal of content or information they have publicly posted. To request removal of such data, and if You are a California resident, You can contact Us using the contact information provided below and include the email address associated with Your account. Be aware that Your request does not guarantee complete or comprehensive removal of content or information posted online and that the law may not permit or require removal in certain circumstances.",
      ],
    },
    {
      heading: "Links to Other Websites",
      body: [
        "Our Service may contain links to other websites that are not operated by Us. If You click on a third-party link, You will be directed to that third party’s site. We strongly advise You to review the Privacy Policy of every site You visit. We have no control over and assume no responsibility for the content, privacy policies or practices of any third-party sites or services.",
      ],
    },
    {
      heading: "Changes to this Privacy Policy",
      body: [
        "We may update Our Privacy Policy from time to time. We will notify You of any changes by posting the new Privacy Policy on this page. We will let You know via email and/or a prominent notice on Our Service, prior to the change becoming effective and update the “Last updated” date at the top of this Privacy Policy. You are advised to review this Privacy Policy periodically for any changes. Changes to this Privacy Policy are effective when they are posted on this page. Where a change materially affects how We use personal information You have already given Us, We will give You notice before the change takes effect and, where the law requires Your consent, We will obtain it.",
      ],
    },
    {
      heading: "Contact Us",
      body: [
        "If you have any questions about this Privacy Policy, You can contact us:",
        "By email: hello@arkmedia.org",
        "By mail: Ark Media Podcast LLC, 268 E Broadway, New York, New York 10002-5672, United States.",
      ],
    },
  ],
};

export const TERMS: LegalDoc = {
  title: "Terms of Service.",
  lede: "Please read these Terms and Conditions carefully before using Our Service.",
  lastUpdated: "2026-10-05",
  draft: false,
  sections: [
    {
      heading: "Interpretation and Definitions",
      body: [
        { subheading: "Interpretation" },
        "The words of which the initial letter is capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.",
        { subheading: "Definitions" },
        "For the purposes of these Terms and Conditions:",
        {
          list: [
            "**Affiliate**: means an entity that controls, is controlled by or is under common control with a party, where “control” means ownership of 50% or more of the shares, equity interest or other securities entitled to vote for election of directors or other managing authority.",
            "**Account**: means a unique account created for You to access our Service or parts of our Service.",
            "**Company** (referred to as either “the Company”, “We”, “Us” or “Our” in this Agreement): refers to Ark Media Podcast LLC, a Delaware limited liability company, which produces and distributes podcasts, newsletters and related subscription products.",
            "**Device**: means any device that can access the Service such as a computer, a cellphone or a digital tablet.",
            "**Feedback**: means feedback, innovations or suggestions sent by You regarding the attributes, performance or features of our Service.",
            "**Free Trial**: refers to a limited period of time that may be free when purchasing a Subscription.",
            "**Service**: means the Website, the Subscriptions, the Newsletter, the Private Podcast Feeds, the Community and any other content, products or services We make available.",
            "**Subscriptions**: refer to the services or access to the Service offered on a subscription basis by the Company to You.",
            "**Terms and Conditions** (also referred as “Terms”): mean these Terms and Conditions that form the entire agreement between You and the Company regarding the use of the Service.",
            "**Third-party Social Media Service**: means any services or content (including data, information, products or services) provided by a third-party that may be displayed, included or made available by the Service.",
            "**Website**: means Ark Media’s websites and applications, including https://arkmedia.org and https://app.arkmedia.org, together with any successor or related properties.",
            "**Community**: means The Fold, the Ark Media online community made available to certain Subscriptions, hosted on the Circle platform and accessible on the web and through a mobile app.",
            "**Community Guidelines**: means the rules of participation We post in the Community, as updated from time to time.",
            "**Member Content**: means anything You post, upload or submit to the Community, including text, images, audio, video and links.",
            "**Newsletter**: means the Ark Media email newsletter delivered through Beehiiv, in both its free version and any version included with a Subscription.",
            "**Private Podcast Feed**: means a subscriber-specific podcast feed URL issued to You as part of certain Subscriptions.",
            "**Third-Party Platform**: means a service We use to operate the Service, including Beehiiv, Circle, Auth0 and Stripe.",
            "**You**: means the individual accessing or using the Service, or the company, or other legal entity on behalf of which such individual is accessing or using the Service, as applicable.",
          ],
        },
      ],
    },
    {
      heading: "Acknowledgment",
      body: [
        {
          list: [
            "These are the Terms and Conditions governing the use of this Service and the agreement that operates between You and the Company. These Terms and Conditions set out the rights and obligations of all users regarding the use of the Service.",
            "Your access to and use of the Service is conditioned on Your acceptance of and compliance with these Terms and Conditions. These Terms and Conditions apply to all visitors, users and others who access or use the Service.",
            "By accessing or using the Service You agree to be bound by these Terms and Conditions. If You disagree with any part of these Terms and Conditions, then You may not access the Service.",
            "You represent that You are over the age of 18. The Company does not permit those under 18 to use the Service. If We learn that an Account holder is under 18, We will close the Account and delete the information We have collected.",
            "Your access to and use of the Service is also conditioned on Your acceptance of and compliance with the Privacy Policy of the Company. Our Privacy Policy describes Our policies and procedures on the collection, use and disclosure of Your personal information when You use the Service and tells You about Your privacy rights and how the law protects You. Please read Our Privacy Policy carefully before using Our Service.",
            "You accept these Terms by clicking “I agree” (or a similar control) at checkout, by creating an Account, or by using the Service. If You do not agree, do not purchase a Subscription and do not use the Service.",
            "These Terms include a binding arbitration provision and a waiver of class actions and jury trials in the section titled “Dispute Resolution.” Please read that section carefully; it affects how disputes between You and the Company are resolved.",
          ],
        },
      ],
    },
    {
      heading: "Purchases and Payment",
      body: [
        "By purchasing a Subscription, You represent that You are legally capable of entering into binding contracts and that You are at least 18 years old.",
        { subheading: "Your Information" },
        {
          list: [
            "To purchase a Subscription You may be asked to supply certain information, including Your name, Your email address and Your billing address. Payment card details are collected and processed by Stripe, Our payment processor. We do not receive or store Your full payment card number.",
            "You represent and warrant that: (i) You have the legal right to use any credit or debit card(s) or other payment method(s) in connection with any purchase; and that (ii) the information You supply to us is true, correct and complete.",
            "By submitting such information, You grant us the right to provide the information to payment processing third parties for purposes of facilitating the completion of Your purchase.",
          ],
        },
        { subheading: "Payments" },
        "Subscription payments are processed by Stripe. Payment can be made through the payment methods Stripe makes available to Us at checkout.",
        "Payment cards (credit cards or debit cards) are subject to validation checks and authorization by Your card issuer. If we do not receive the required authorization, We will not be liable for any resulting delay in providing the Service.",
        "We make reasonable efforts to describe and price the Service accurately, but errors can occur. If a Subscription is listed at an incorrect price, We may cancel the purchase and refund any amount You paid. We will not charge You more than the price displayed to You at checkout for the then-current Subscription period.",
      ],
    },
    {
      heading: "Subscriptions",
      body: [
        { subheading: "Subscription period" },
        "The Service or some parts of the Service are available only with a paid Subscription. You will be billed in advance on a recurring and periodic basis (such as daily, weekly, monthly or annually), depending on the type of Subscription plan You select when purchasing the Subscription. At the end of each period, Your Subscription will automatically renew under the exact same conditions unless You cancel it or the Company cancels it. Before You are charged, We will disclose the Subscription price, the billing frequency, the fact that the Subscription renews automatically until You cancel, and how to cancel. After You purchase, We will send You an acknowledgment of those automatic renewal terms and cancellation instructions in a form You can keep.",
        { subheading: "What Your Subscription Includes" },
        "Every Subscription purchased through the Website includes the Newsletter. Depending on the Subscription You purchase, You may also receive one or more Private Podcast Feeds and access to the Community. The benefits included in each Subscription are described at checkout. We may add benefits at any time, and We may remove a material benefit only on notice to You and with the right to cancel for a pro-rated refund of the unused portion of Your then-current Subscription period.",
        { subheading: "Subscriptions Purchased Through Third-Party Platforms" },
        "If You purchase a Subscription through a third-party platform, such as Apple Podcasts, that platform sells the Subscription to You and processes Your payment under its own terms. Billing, automatic renewal, cancellation and refunds for that Subscription are handled by the platform, and You must manage or cancel it through Your account with that platform; We cannot cancel it or issue a refund for You. The provisions of these Terms on billing, renewal reminders, cancellation and refunds apply only to Subscriptions purchased through the Website. The benefits included with a Subscription purchased through a third-party platform are described at the time of purchase and may differ from those included with a Subscription purchased through the Website.",
        { subheading: "Renewal Reminders" },
        "Where required by applicable law, We will send You a reminder before Your Subscription renews, including the renewal date, the amount that will be charged and how to cancel.",
        { subheading: "Subscription cancellations" },
        "You may cancel Your Subscription at any time, without charge and without having to speak to anyone, through Your Account settings page. The method We provide for cancelling will be at least as simple as the method You used to subscribe and will be available in the same medium in which You subscribed. You may also cancel by contacting Us at hello@arkmedia.org. Unless applicable law requires otherwise, You will not receive a refund for fees already paid for Your current Subscription period, and You will keep access to the Service until the end of that period. Any other refund request will be considered case by case at the Company’s discretion.",
        { subheading: "Billing" },
        "You shall provide the Company with accurate and complete billing information including full name, address, state, zip code, telephone number, and a valid payment method information.",
        "Should automatic billing fail to occur for any reason, the Company will issue an electronic invoice indicating that You must proceed manually, within a certain deadline date, with the full payment corresponding to the billing period as indicated on the invoice.",
        { subheading: "Fee Changes" },
        {
          list: [
            "The Company, in its sole discretion and at any time, may modify the Subscription fees. Any Subscription fee change will become effective at the end of the then-current Subscription period, and We will give You at least thirty (30) days’ notice before it takes effect.",
            "The Company will provide You with reasonable prior notice of any change in Subscription fees to give You an opportunity to terminate Your Subscription before such change becomes effective.",
            "If You continue Your Subscription after a fee change takes effect, You are agreeing to pay the modified fee. Where applicable law requires Your affirmative consent to a material change in the automatic renewal terms, We will obtain that consent before the change takes effect.",
          ],
        },
        { subheading: "Refunds" },
        "Except when required by law, paid Subscription fees are non-refundable. Certain refund requests for Subscriptions may be considered by the Company on a case-by-case basis and granted at the sole discretion of the Company. Nothing in this section limits any cancellation or refund right You have under applicable law, including the automatic renewal statutes of California, New York and other states.",
        { subheading: "Free Trial" },
        {
          list: [
            "The Company may, at its sole discretion, offer a Subscription with a Free Trial for a limited period of time.",
            "You may be required to enter Your billing information in order to sign up for the Free Trial.",
            "If You do enter Your billing information when signing up for a Free Trial, You will not be charged by the Company until the Free Trial has expired. On the last day of the Free Trial period, unless You cancelled Your Subscription, You will be automatically charged the applicable Subscription fees for the type of Subscription You have selected. Before the Free Trial ends We will remind You of the date the trial expires, the amount You will be charged and how to cancel.",
            "At any time and without notice, the Company reserves the right to (i) modify the Terms and Conditions of the Free Trial offer, or (ii) cancel such Free Trial offer.",
          ],
        },
      ],
    },
    {
      heading: "User Accounts",
      body: [
        {
          list: [
            "When You create an Account with Us, You must provide Us information that is accurate, complete, and current at all times. Failure to do so constitutes a breach of the Terms, which may result in immediate termination of Your Account on Our Service.",
            "You are responsible for safeguarding the password that You use to access the Service and for any activities or actions under Your password, whether Your password is with Our Service or a Third-Party Social Media Service.",
            "You agree not to disclose Your password to any third party. You must notify Us immediately upon becoming aware of any breach of security or unauthorized use of Your Account.",
          ],
        },
        "You may not use as a username the name of another person or entity or that is not lawfully available for use, a name or trademark that is subject to any rights of another person or entity other than You without appropriate authorization, or a name that is otherwise offensive, vulgar or obscene.",
        "Account creation and login are managed through Our authentication provider, Auth0. If You choose to sign in using a third-party identity provider, that provider will share certain information with Us, and its own terms and privacy policy will apply to Your use of it. Our Privacy Policy describes what We receive.",
      ],
    },
    {
      heading: "Copyright and Content Usage by Users",
      body: [
        "The content available through the Service, including but not limited to audio recordings, transcripts, written materials, graphics, and logos (collectively, “Content”), is the property of the Company or its licensors and is protected by copyright, trademark, and other intellectual property laws.",
        "You may access and use the Content solely for your personal, non-commercial use, unless otherwise explicitly authorized by the Company. Without the prior written consent of the Company, You may not:",
        {
          list: [
            "Reproduce, distribute, publicly display, publish, transmit, or otherwise make available any part of the Content;",
            "Modify, adapt, translate, or create derivative works of the Content;",
            "Use any Content, including transcripts or audio, for commercial purposes, including but not limited to resale, monetization, or inclusion in a commercial product or service;",
            "Remove, alter, or obscure any proprietary notices or disclaimers contained in the Content.",
          ],
        },
        "Nothing in these Terms limits any use of the Content that is permitted under applicable copyright law. Unauthorized use of the Content may result in legal action.",
      ],
    },
    {
      heading: "Newsletter and Communications",
      body: [
        "The Newsletter is delivered through Beehiiv. Anyone may sign up for its free version, and every Subscription purchased through the Website includes it. When You purchase a Subscription through the Website, We enroll You in the Newsletter. If You purchase a Subscription through a third-party platform, such as Apple Podcasts, We do not receive Your email address and cannot enroll You, but You may sign up for the Newsletter directly. If You sign up for the free version of the Newsletter, these Terms apply to Your use of it.",
        "You may unsubscribe from the Newsletter at any time using the unsubscribe link in any Newsletter email or by contacting Us at hello@arkmedia.org. Unsubscribing does not cancel Your Subscription.",
        "Unsubscribing from the Newsletter does not stop transactional and service messages. We will continue to send You receipts, renewal and cancellation notices, Private Podcast Feed links, and account and security notices for as long as You hold an Account, because those messages are necessary to provide the Service.",
        "If You are located in the European Economic Area, the United Kingdom, Switzerland or Israel, We will give You the opportunity to decline the Newsletter when You purchase a Subscription, and We will not enroll You if You decline.",
      ],
    },
    {
      heading: "Private Podcast Feeds",
      body: [
        "Certain Subscriptions include one or more Private Podcast Feeds. A Private Podcast Feed is delivered to You as a unique URL that identifies Your Account.",
        "Your Private Podcast Feed URL is personal to You. You may not share, publish, post, resell, or otherwise make it available to any other person, and You may not use it to make the audio available to anyone else.",
        "If We reasonably believe a Private Podcast Feed URL has been shared or is being accessed by someone other than the Account holder, We may issue a new URL, limit the number of devices that can use it, or suspend or revoke access.",
        "Access to the Private Podcast Feeds ends when Your Subscription ends. Episodes You have already downloaded remain subject to the restrictions in the section titled “Copyright and Content Usage by Users.”",
      ],
    },
    {
      heading: "Community",
      body: [
        "Certain Subscriptions include access to the Community, which is hosted on the Circle platform. Your use of the Community is also subject to Circle’s own terms of service and privacy policy. As between You and the Company, these Terms govern Our obligations to You.",
        "The Community Guidelines are part of these Terms. By participating in the Community You agree to follow them.",
        { subheading: "Member Content" },
        "You keep ownership of Your Member Content. You grant the Company a non-exclusive, worldwide, royalty-free, sublicensable and transferable license to host, store, reproduce, display, perform, distribute and adapt Your Member Content for the purpose of operating, improving and promoting the Service. That license ends when You delete Your Member Content, except for copies other members have already received and routine backup copies.",
        "You represent that You own or otherwise have the rights to Your Member Content, and that it does not infringe anyone’s rights or violate any law.",
        { subheading: "Other Members" },
        "Member Content is created by other members, not by the Company. We do not endorse it and We are not responsible for it. Other members can see the information in Your Community profile and anything You post. Our Privacy Policy describes what is visible to whom.",
        "Your interactions with other members, including through direct messages and any meeting in person, are solely between You and them. We do not screen or verify members, conduct background checks or supervise communications between members, and We do not organize, sponsor or supervise in-person meetings between members unless We expressly say so for a specific event. Use caution and good judgment in dealing with other members, particularly before sharing personal information or meeting anyone in person.",
        "If another member harasses, threatens or otherwise mistreats You, report it to Us at hello@arkmedia.org or through the reporting tools in the Community. We may, but are not obligated to, investigate and act on reports, including by reviewing messages that are reported to Us.",
        "To the fullest extent permitted by law, You release the Company and its officers, members, employees and agents from any claim, demand or damages of any kind arising out of or relating to any dispute between You and another member, including any conduct of a member online or offline. If You are a California resident, You waive California Civil Code section 1542, which says: “A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party.” You also waive any similar law of any other jurisdiction.",
        { subheading: "Moderation" },
        "We are not obligated to monitor the Community, but We may review, remove or restrict any Member Content, and We may suspend or terminate any member’s access, at Our discretion and without notice, including for a violation of these Terms or the Community Guidelines. If We terminate a paid Subscription for a violation, We are not required to issue a refund.",
        "When Your access to the Community ends, We will either deactivate or delete Your Community account. If We deactivate it, Your profile is hidden but the Member Content You posted, including direct messages, remains visible to other members with Your name attached. If We delete it, or if You ask Us to delete it, Your profile and all of Your Member Content are permanently erased, including from threads and conversations with other members.",
        { subheading: "Mobile App" },
        "The Community is also available through a mobile app. If You download the app from an app store, Your use of the app store is subject to its own terms.",
        "If You download the app from the Apple App Store, the following also applies. These Terms are between You and the Company only, and not Apple, and the Company, not Apple, is responsible for the app and its content. Your license to use the app is limited to use on Apple-branded products that You own or control, as permitted by the App Store usage rules. Apple has no obligation to provide maintenance or support for the app. If the app fails to conform to any applicable warranty, You may notify Apple and Apple will refund the purchase price of the app, if any; to the maximum extent permitted by law, Apple has no other warranty obligation with respect to the app. The Company, not Apple, is responsible for addressing any claim by You or a third party relating to the app, including product liability claims, claims that the app fails to conform to any legal or regulatory requirement, and claims arising under consumer protection or privacy law, and for investigating, defending, settling and discharging any claim that the app or Your use of it infringes a third party’s intellectual property rights. Apple and its subsidiaries are third-party beneficiaries of these Terms and may enforce them against You.",
      ],
    },
    {
      heading: "Acceptable Use",
      body: [
        "You agree not to:",
        {
          list: [
            "share Your Account credentials or any Private Podcast Feed URL with anyone else;",
            "post or transmit anything that is unlawful, defamatory, harassing, abusive, threatening, hateful, obscene, or that violates anyone’s privacy or publicity rights;",
            "harass, stalk, threaten or intimidate any member, including through direct messages, or keep contacting a member who has asked You to stop;",
            "infringe or misappropriate anyone’s copyright, trademark, trade secret or other rights;",
            "upload malware or anything designed to interfere with the Service;",
            "scrape, crawl, harvest or otherwise use automated means to access or extract the Content or any member’s information;",
            "use the Content, including audio and transcripts, to train a machine learning or artificial intelligence model, without Our prior written permission;",
            "circumvent any paywall, access restriction or security measure;",
            "impersonate any person or misrepresent Your affiliation with anyone; or",
            "use the Service to send unsolicited advertising or solicitations.",
          ],
        },
      ],
    },
    {
      heading: "Copyright Complaints",
      body: [
        "We respond to notices of alleged copyright infringement. If You believe material on the Service infringes Your copyright, send Our designated agent a written notice that includes: a signature of the copyright owner or a person authorized to act for the owner; identification of the copyrighted work claimed to be infringed; identification of the material You say is infringing and enough information for Us to locate it; Your contact information; a statement that You have a good faith belief the use is not authorized by the copyright owner, its agent or the law; and a statement, under penalty of perjury, that the information in the notice is accurate and that You are authorized to act on the owner’s behalf.",
        "Designated agent: [Name], Ark Media Podcast LLC, 268 E Broadway, New York, New York 10002-5672, United States, [email address], [telephone number].",
        "If Your Member Content was removed and You believe the removal was a mistake or misidentification, You may send Our designated agent a counter-notification containing the information required by 17 U.S.C. § 512(g).",
        "We will terminate the Accounts of repeat infringers in appropriate circumstances.",
      ],
    },
    {
      heading: "Third-Party Platforms",
      body: [
        "We use Third-Party Platforms to operate the Service: Beehiiv delivers the Newsletter and the Private Podcast Feeds, Circle hosts the Community, Auth0 provides authentication, and Stripe processes payments. Your use of a Third-Party Platform may also be governed by that platform’s own terms and privacy policy.",
        "We are not responsible for the acts or omissions of a Third-Party Platform, and their availability is not within Our control. Our Privacy Policy describes what information is shared with each of them.",
      ],
    },
    {
      heading: "Indemnification",
      body: [
        "You will defend, indemnify and hold harmless the Company and its officers, members, employees and agents from and against any claim, demand, loss, liability or expense, including reasonable attorneys’ fees, arising out of or relating to Your Member Content, Your use of the Service, Your breach of these Terms or the Community Guidelines, or Your violation of any law or of any right of a third party.",
      ],
    },
    {
      heading: "Your Feedback to Us",
      body: [
        "You assign all rights, title and interest in any Feedback You provide the Company. If for any reason such assignment is ineffective, You agree to grant the Company a non-exclusive, perpetual, irrevocable, royalty free, worldwide right and license to use, reproduce, disclose, sub-license, distribute, modify and exploit such Feedback without restriction.",
      ],
    },
    {
      heading: "Links to Other Websites",
      body: [
        "Our Service may contain links to third-party web sites or services that are not owned or controlled by the Company.",
        "The Company has no control over, and assumes no responsibility for, the content, privacy policies, or practices of any third party web sites or services. You further acknowledge and agree that the Company shall not be responsible or liable, directly or indirectly, for any damage or loss caused or alleged to be caused by or in connection with the use of or reliance on any such content, goods or services available on or through any such web sites or services.",
        "We strongly advise You to read the Terms and Conditions and privacy policies of any third-party web sites or services that You visit.",
      ],
    },
    {
      heading: "Termination",
      body: [
        "We may terminate or suspend Your Account immediately, without prior notice or liability, for any reason whatsoever, including without limitation if You breach these Terms and Conditions.",
        "Upon termination, Your right to use the Service will cease immediately. If You wish to terminate Your Account, You may simply discontinue using the Service. When Your Account is terminated, Your access to the Community and to any Private Podcast Feed ends, and We may revoke Your Private Podcast Feed URLs.",
      ],
    },
    {
      heading: "Limitation of Liability",
      body: [
        "Notwithstanding any damages that You might incur, the entire liability of the Company and any of its suppliers under any provision of this Terms and Your exclusive remedy for all of the foregoing shall be limited to the greater of the amount actually paid by You through the Service in the twelve (12) months preceding the event giving rise to the liability, or 100 USD.",
        "To the maximum extent permitted by applicable law, in no event shall the Company or its suppliers be liable for any special, incidental, indirect, or consequential damages whatsoever (including, but not limited to, damages for loss of profits, loss of data or other information, for business interruption, for personal injury, loss of privacy arising out of or in any way related to the use of or inability to use the Service, third-party software and/or third-party hardware used with the Service, or otherwise in connection with any provision of this Terms), even if the Company or any supplier has been advised of the possibility of such damages and even if the remedy fails of its essential purpose.",
        "Some states do not allow the exclusion of implied warranties or limitation of liability for incidental or consequential damages, which means that some of the above limitations may not apply. In these states, each party’s liability will be limited to the greatest extent permitted by law.",
      ],
    },
    {
      heading: "“AS IS” and “AS AVAILABLE” Disclaimer",
      body: [
        "The Service is provided to You “AS IS” and “AS AVAILABLE” and with all faults and defects without warranty of any kind. To the maximum extent permitted under applicable law, the Company, on its own behalf and on behalf of its Affiliates and its and their respective licensors and service providers, expressly disclaims all warranties, whether express, implied, statutory or otherwise, with respect to the Service, including all implied warranties of merchantability, fitness for a particular purpose, title and non-infringement, and warranties that may arise out of course of dealing, course of performance, usage or trade practice. Without limitation to the foregoing, the Company provides no warranty or undertaking, and makes no representation of any kind that the Service will meet Your requirements, achieve any intended results, be compatible or work with any other software, applications, systems or services, operate without interruption, meet any performance or reliability standards or be error free or that any errors or defects can or will be corrected.",
        "Without limiting the foregoing, neither the Company nor any of the company’s provider makes any representation or warranty of any kind, express or implied: (i) as to the operation or availability of the Service, or the information, content, and materials or products included thereon; (ii) that the Service will be uninterrupted or error-free; (iii) as to the accuracy, reliability, or currency of any information or content provided through the Service; or (iv) that the Service, its servers, the content, or e-mails sent from or on behalf of the Company are free of viruses, scripts, trojan horses, worms, malware, timebombs or other harmful components.",
        "Some jurisdictions do not allow the exclusion of certain types of warranties or limitations on applicable statutory rights of a consumer, so some or all of the above exclusions and limitations may not apply to You. But in such a case the exclusions and limitations set forth in this section shall be applied to the greatest extent enforceable under applicable law.",
      ],
    },
    {
      heading: "Governing Law",
      body: [
        "These Terms and Your use of the Service are governed by the laws of the State of New York, excluding its conflict of laws rules. Subject to the section titled “Dispute Resolution,” You and the Company agree that the state and federal courts located in New York County, New York have exclusive jurisdiction over any dispute that is not subject to arbitration. Your use of the Service may also be subject to other local, state, national or international laws.",
      ],
    },
    {
      heading: "Dispute Resolution",
      body: [
        "Please read this section carefully. It affects Your rights, including Your right to bring a lawsuit in court and to participate in a class action.",
        { subheading: "Informal Resolution First" },
        "Before starting an arbitration, You agree to email Us at hello@arkmedia.org with a short description of the dispute and the relief You are seeking, and to give Us sixty (60) days to resolve it. We will do the same before starting an arbitration against You.",
        { subheading: "Binding Arbitration" },
        "If the dispute is not resolved informally, You and the Company agree that it will be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court. The Federal Arbitration Act governs this section. The arbitrator’s award may be entered as a judgment in any court with jurisdiction. The arbitration will take place in the county where You live or, at Your election, by telephone or videoconference.",
        { subheading: "Class Action and Jury Trial Waiver" },
        "YOU AND THE COMPANY AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY, AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE OR REPRESENTATIVE PROCEEDING. YOU AND THE COMPANY ALSO WAIVE THE RIGHT TO A TRIAL BY JURY. The arbitrator may not consolidate the claims of more than one person without the consent of both parties. If this paragraph is found unenforceable, then this entire Dispute Resolution section does not apply and any dispute will be resolved in court.",
        { subheading: "Your Right to Opt Out" },
        "You may opt out of arbitration and the class action waiver by emailing hello@arkmedia.org within thirty (30) days after You first accept these Terms, with Your name, the email address on Your Account and a statement that You are opting out. Opting out does not affect any other part of these Terms, and it will not affect Your Subscription.",
        { subheading: "Exceptions" },
        "Either party may bring an individual claim in small claims court, and either party may ask a court for an injunction to stop infringement or misuse of its intellectual property.",
        { subheading: "Coordinated Claims" },
        "If twenty-five (25) or more claims of a similar nature are filed against the Company by or with the assistance of the same or coordinated counsel, the claims will be arbitrated in batches of no more than fifty (50), with a single arbitrator for each batch, and the limitations period will be tolled for claims awaiting their batch.",
      ],
    },
    {
      heading: "For European Union (EU) Users",
      body: [
        "If You are a European Union consumer, You will benefit from any mandatory provisions of the law of the country in which You are resident in.",
      ],
    },
    {
      heading: "United States Federal Government End Use Provisions",
      body: [
        "If You are a U.S. federal government end user, our Service is a “Commercial Item” as that Term is defined at 48 C.F.R. §2.101.",
      ],
    },
    {
      heading: "United States Legal Compliance",
      body: [
        "You represent and warrant that (i) You are not located in a country that is subject to the United States government embargo, or that has been designated by the United States government as a “terrorist supporting” country, and (ii) You are not listed on any United States government list of prohibited or restricted parties.",
      ],
    },
    {
      heading: "Severability and Waiver",
      body: [
        { subheading: "Severability" },
        "If any provision of these Terms is held to be unenforceable or invalid, such provision will be changed and interpreted to accomplish the objectives of such provision to the greatest extent possible under applicable law and the remaining provisions will continue in full force and effect.",
        { subheading: "Waiver" },
        "Except as provided herein, the failure to exercise a right or to require performance of an obligation under these Terms shall not affect a party’s ability to exercise such right or require such performance at any time thereafter nor shall the waiver of a breach constitute a waiver of any subsequent breach.",
      ],
    },
    {
      heading: "Translation Interpretation",
      body: [
        "These Terms and Conditions may have been translated if We have made them available to You on our Service. You agree that the original English text shall prevail in the case of a dispute.",
      ],
    },
    {
      heading: "Changes to These Terms and Conditions",
      body: [
        "We reserve the right, at Our sole discretion, to modify or replace these Terms at any time. If a revision is material, We will make reasonable efforts to provide at least 30 days’ notice prior to any new Terms taking effect. What constitutes a material change will be determined at Our sole discretion. For subscribers, a material change takes effect at the start of Your next Subscription period, and where applicable law requires Your affirmative consent to a material change, We will obtain it before the change applies to You.",
        "By continuing to access or use Our Service after those revisions become effective, You agree to be bound by the revised Terms. If You do not agree to the new Terms, in whole or in part, please stop using the website and the Service. If You do not agree to a change, You may cancel Your Subscription before it takes effect.",
      ],
    },
    {
      heading: "Contact Us",
      body: [
        "If You have any questions about these Terms and Conditions, You can contact us at hello@arkmedia.org, or through our contact form. Our mailing address is 268 E Broadway, New York, New York 10002-5672, United States.",
      ],
    },
  ],
};

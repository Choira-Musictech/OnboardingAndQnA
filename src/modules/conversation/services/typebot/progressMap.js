// ==================================================================
// GENERATED FILE - do not edit by hand.
//   npm run build:progress-map
// Re-run it after every Studio republish. See scripts/build-progress-map.mjs.
//
// Typebot's Chat API never returns a `progress` field (confirmed live -
// startChat/continueChat responses only ever carry sessionId/resultId/
// typebot/messages/input/clientSideActions/logs; Studio's "Enable
// progress bar" toggle only affects Typebot's own embed widget, not the
// API). This backend drives the conversation by API relay, not the
// embed, so progress has to be computed here.
//
// Each value is "questions already answered / questions on this path",
// computed per block from the published flow's graph. It is NOT measured
// against a single global step count: the four role paths run 26 to 34
// questions, and one shared total would leave the short paths stuck
// below 100% forever.
//
// Nothing here reaches 100 on purpose - registrationEngine.handle()
// forces 100 when the session actually ends, and while the payment
// button is still on screen the member hasn't finished.
//
// Verified at generation time: progress never decreases along any edge.
// ==================================================================
const PROGRESS_BY_BLOCK = {
  tebp7htyvolml8wokttg66pw:   0, // choice input Yes, I want to become a member / हाँ, मैं 
  ofaqjfre4b6smht07inyag0w:   3, // choice input applicantPath
  flgpd2vixmu0djiomet77kmn:   6, // choice input EntityType
  mdqj3iyf81wm5p5ihbs4gkoo:   6, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  oxw82owm9r4i9d24eat8mgzs:   6, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  pdxi4upcgfjmrdhfcut6g7r5:   7, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  i1e0ui8ulp9upo2qo6n9hzx5:   8, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  dha20qnmgdroevgtjahyvgq4:   9, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  kw6hmomfcpco0h1o7k7a5q31:   9, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  yx4om90mie9j0ol0d8s3jo2r:   9, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  dfjq3jnt9camad1fz1g80fj5:  10, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  ahyzplqvx3ui5juwrrox3ueu:  11, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  f8oqkbtb5aod4zixk9g61p4k:  11, // text input   email
  fvuq2fhprp6lglzwaymzbax1:  11, // text input   email
  demje4616e1wsj8sndh5u6xp:  13, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  lhn01sxvz2v2e4t3rekoqej7:  13, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  pngh7jejhf2y9ewxztmu815l:  13, // choice input I Accept / मैं स्वीकार करता/करती हूँ / मी 
  pz63sk8srnnwtctc4bg4sxto:  14, // text input   place_of_birth
  r5yv2rbnzed9r6m3870yr7l6:  14, // choice input gst_options
  b7635myaqyeudck8wk20ml1l:  15, // text input   email
  oq9t8my7r1eosq7d5438g5x8:  16, // file input   MAA_Upload
  sqz4yjzlstxdju4e5ebp3uoq:  16, // file input   TUM_Upload
  teoi74ucijg9o4kn1pasfr3m:  16, // file input   PartnerD_upload
  ibbe01buu9psnjogoq0unpjw:  17, // choice input role
  paqezgvjit32irt79tl5pc38:  17, // text input   gst_no
  n5zfjvv6ugnj1i6qrwph35vl:  19, // file input   selfDecleration_upload
  vcfzj48k42e2mtv7ijh96gc5:  19, // file input   BR_Upload
  vfvvwcz6g7ueiw2lhqnwvg9z:  19, // text input   place_of_birth
  wo33kybz0dcp0hawk4f6yis7:  19, // file input   AuthorityLetter_Upload
  z0yx9nnq5i3p1t1pb7v44pcy:  19, // text input   designation
  xsj8j0zvs2ao5qdwr9m0hzv3:  20, // choice input Yes / हाँ / होय / હા
  e5s5cxj9n6eh6ubaz573m0vx:  22, // file input   company_noc
  ks6q7z5mrubjqemaxa4f4eq4:  22, // text input   MotherTounge
  qvo8thfagkj2mixdoj382da4:  22, // choice input role
  wddfpadpnsiw8fpc1w5z05n1:  22, // file input   letter
  fmxzyrlpsf9zjmk9exsi3ek3:  23, // text input   gst_no
  dvj39jnp3mzfbl49k11837bx:  25, // text input   trc_no
  s1x2bk8lawg44n75cnhxqqz9:  25, // text input   email
  a5aujns6i7dhbqklnl755gpv:  26, // choice input Yes / हाँ / होय / હા
  vws1gmd9irrbu70mlxxcx3zi:  26, // choice input Yes / हाँ / होय / હા
  h0nif8vdjloh9eytol30imnc:  28, // choice input Yes / हाँ / होय / હા
  rq2atmhhs9siv7psmxmg636n:  28, // file input   company_pan
  n2u940qt8ltxoltppyvmfxpn:  29, // choice input teritory
  ktd9g9e08s6uz1tddf0imyye:  30, // text input   gst_no
  epndixa98cgkdrjnul7he2xt:  31, // file input   Noc
  ks91rw3cq2xrxt1099yy2516:  31, // text input   assosiation_name
  up4you8ef2sxppryl6ie6cp1:  31, // text input   designation
  fibjujil57kdwaiex3vosqzm:  33, // choice input Yes, I’ll type it / हाँ, मैं टाइप करूँगा/क
  oqg4nwlfseo7drc66aq10m9e:  33, // choice input Yes / हाँ / होय / હા
  dwt2rzc2jk3wiehx901m0eu1:  34, // text input   MotherTounge
  edgjtvqj0i5qwjfv0r1zkedd:  34, // file input   photo
  w9hjqpdkcyjqxdc64tv9u89g:  36, // text input   chanel_desc
  dup21pngh3d0pai4oxxjcqzs:  37, // text input   assosiation_name
  xahqzzlwvjiv0rdk1ub30j8o:  37, // text input   MotherTounge
  memgr2g4fj0bth4czl4v3l0w:  38, // choice input Yes / हाँ / होय / હા
  ml1pehw1jjrzcbflrezsarl7:  39, // file input   company_photo
  xo78fggijfbfefgqne6dcw6g:  40, // text input   trc_no
  g2c93kyw19nogtv0sjhpowuy:  41, // text input   assosiation_name
  q3xl3vlud9r71twny3xpj5uz:  41, // text input   MotherTounge
  q18gas1hym790bfnrtp5mpcd:  42, // choice input address_proof_type_current
  et7njpjjc6gwz95rmdcr30nt:  43, // file input   passport_indivisual
  cbeexxvp4afbdv21ch60conz:  44, // choice input Yes, I’ll type it / हाँ, मैं टाइप करूँगा/क
  dpxeg6y2w8fof0r4ftp2ft53:  44, // text input   registered_address_type
  j40owea6u92m53dxgpnwace5:  44, // choice input Yes / हाँ / होय / હા
  k125w7fe75aqhv7gthubusai:  44, // file input   registered_address
  krk5m92ihv5kaildp8jajdxj:  46, // file input   TRC
  cbmqojadjfm2jmbk9c17a59q:  47, // choice input Yes / हाँ / होय / હા
  t9nsr5eogpk34tqtghgbotqu:  47, // text input   chanel_desc
  ni0xbtx0htpr10x1setrq4u3:  48, // choice input teritory
  pxkfaxu6vkui9uv1by5mgua9:  49, // choice input Yes / हाँ / होय / હા
  cyci95gi706rpw8tva4e3ouo:  50, // choice input address_proof_type_current
  tj7pvwqhic7u6rmq436bhtvf:  50, // file input   company_photo
  nyx2jmkbywlvf5ixvinjii2a:  51, // text input   assosiation_name
  o5n5chjkhwof7ytyks400haq:  52, // file input   Noc
  bl3ree1x725036j6wax3uav7:  53, // file input   comm_address2
  g5frg3j9pemyoidcvobsa2px:  53, // text input   comm_address2_type
  kg2i35l2491u5hopas7stdg4:  53, // choice input address_proof_type_current
  z0kyyoqr5nez31rlfpk5ppdv:  54, // text input   nationality
  lezz4jxutykbfoq2r3ae0jkq:  56, // choice input Yes / हाँ / होय / હા
  vqwuvk0vnzab8eol51i86j64:  56, // file input   photo
  yvahr8qbkgfhfuonsrkr49mq:  56, // file input   registered_address
  w8beaa44i3s8v46gzwhkbgzz:  57, // choice input dual_nationality
  qx9rpzvntiprq90gx1np7bmj:  58, // choice input teritory
  ddk7tlmjhkvt3zktskzt9i9e:  59, // choice input Yes / हाँ / होय / હા
  x1a4lvyxz085pfhyppef6wnc:  59, // file input   pan_card
  yoh1r11iqch1dipaar7r6pl1:  60, // file input   passbook
  a1b4f5e5unw1ithjp4r5siw5:  61, // file input   Noc
  csntwzyr0k418idnaxk0ha45:  63, // choice input address_proof_type_permanent
  if0fvqm05icv3tuyc3xjc7dj:  63, // choice input address_proof_type_current
  nqyxmnuusz3bq26r0obbmfpl:  63, // file input   passbook
  wiccvvam9g4d7c8ary2kulhu:  64, // file input   passbook
  xqu8sijb9p92shdewvy5qumj:  66, // text input   P_address
  ybcl5sixj22vlhc8llzu49kl:  66, // file input   comm_address
  zr5z6lvgo3tmjkktva9oc2ql:  66, // file input   permanent_address_proof
  gazeo8w40fwvbhuj5a06ftp6:  67, // file input   entity_incorporation_upload
  rpij8g7ou2lertf1xe46bwnc:  67, // choice input address_proof_type_permanent
  ctpx2z89l8pqltt5ehahmq3a:  69, // choice input Yes / हाँ / होय / હા
  vt6oqxd2g7pvbcxegcfbq2vk:  69, // file input   trc_upload
  xwnj50axf9xtvy10ljg1eaie:  69, // choice input Yes / हाँ / होय / હા
  dqphd61tvxp3p2l7jkbyqceh:  70, // file input   permanent_address_proof
  inks0tdl2dbonehscrbhbfqr:  71, // choice input address_proof_type_current
  it7obzdjqi9i5kqsbxz3tffm:  72, // choice input teritory
  o7abkrvjgi0m9p8i0q5qhfob:  72, // file input   tin_upload
  i8v9h0dszpnwphwwl2mxf6te:  74, // choice input Yes / हाँ / होय / હા
  vhickdt8h7avyu2g85e2uooh:  74, // text input   c_address
  vn7pcvzfjzr8xmrkjx9tzwai:  74, // file input   current_address_proof
  jl6epop3i1iaiwhib5xr5d8d:  75, // file input   SS_NumberUpload
  s2g4n58d2ogyr9wp04242yka:  75, // file input   Noc
  iyo96vyr3j95r4qvzw342uhc:  77, // file input   tin_upload
  k05fwzssw7yfyu41xik34ast:  78, // file input   passbook
  ofbhr8kfld8x54f5601rb283:  78, // file input   PEC_Upload
  tk1kdh0b1j6uzvacoo34rp1i:  78, // choice input address_proof_type_current
  vsg89mcrd3pam5m7frypfh0n:  80, // file input   selfDecleration_upload
  jepno1g51m3s76v79kmyukj1:  81, // file input   current_address_proof
  kz2xvxsybq3whe6rh01bjqwf:  81, // choice input address_proof_type_current
  mtj6wazphq42jv0oadtnlozs:  81, // choice input Yes, I’ll upload it / हाँ, मैं अपलोड करूँग
  bg3vzcmdf25l481nt8dwi80r:  83, // file input   comm_address
  o30tr1wttrzh7tc1a7e6gkw2:  83, // file input   SS_NumberUpload
  p5efmf064weo8nardhmx9buy:  84, // file input   gst_certificate_upload
  qje5cvxfiyeyulko9vb54wqb:  85, // choice input Yes, I have an alias/stage name / हाँ, मेर
  dpu1p9v8ysxhkddq2fm73esb:  86, // file input   Form41_upload
  e6n9bs69j5r8vejql1qb9yhd:  86, // file input   Form41_upload
  mpja7mu3exf9537puaxmjjn1:  88, // choice input Yes, I have an alias/stage name / हाँ, मेर
  abpyq4uj0w5512l0clblw6zx:  89, // text input   stageName
  n2pckdbd7ikeetef0k37e9i3:  89, // choice input Yes, I have an alias/stage name / हाँ, मेर
  vbib8eovbot8wizsq2ixu9ie:  89, // file input   letter
  k1pcwt23nmp7s2m9517t2y8b:  91, // text input   traderName
  xp4ynnlivpqzok1byzpgeo8p:  91, // text input   stageName
  xgpnjbhvc7ku42ks8asqyhd4:  92, // text input   traderName
  t7rxqa45lzxn3c20au3xczjd:  93, // url input    workUrl
  s3ve6kasl1rkiun2n9fgtjxu:  94, // url input    workUrl
  uycu77l5avn789uonzyw4nd1:  94, // url input    workUrl
  xnbvoocex284qeg48jbi6ufr:  94, // url input    workUrl
  ufpca0wnuwznk2ks7qbv39py:  96, // choice input Pay Application Fee / आवेदन शुल्क का भुगता
  mqd5zfukd99nkczylu206jo1:  97, // choice input Pay Application Fee / आवेदन शुल्क का भुगता
  o6vjstq2do6uuy67wfbzg451:  97, // choice input Pay Application Fee / आवेदन शुल्क का भुगता
  tjbgzghma2th8et9srotmzt5:  97, // choice input Pay Application Fee / आवेदन शुल्क का भुगता
};

// null for an unknown block - the caller passes that straight through, so a block added in Studio
// before this map is regenerated shows no progress rather than a wrong one.
export function resolveProgress(blockId) {
  return PROGRESS_BY_BLOCK[blockId] ?? null;
}

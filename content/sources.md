# Source registry

The authoritative government sites each jurisdiction's data is compiled from. These are the
**entry points**; individual facts in the JSON files cite the specific page/statute. URLs are
to be confirmed at build time (the pipeline machine-checks that every `sourceUrl` resolves).

## Federal

| Topic | Agency | Source |
| --- | --- | --- |
| Overtime / exemptions / salary levels | DOL Wage & Hour Division | https://www.dol.gov/agencies/whd/overtime |
| Minimum wage | DOL WHD | https://www.dol.gov/agencies/whd/minimum-wage |
| FLSA regulations | eCFR (29 CFR 541) | https://www.ecfr.gov/current/title-29/subtitle-B/chapter-V/subchapter-A/part-541 |
| U.S. Code | Office of Law Revision Counsel | https://uscode.house.gov |
| Discrimination / ADA / ADEA / deadlines | EEOC | https://www.eeoc.gov |
| Concerted activity / pay discussion | NLRB | https://www.nlrb.gov |
| FMLA | DOL WHD | https://www.dol.gov/agencies/whd/fmla |
| State minimum-wage table (cross-check) | DOL | https://www.dol.gov/agencies/whd/minimum-wage/state |

## States — primary labor/wage agency (50 states)

Discrimination claims in many states go through a separate Fair Employment Practices Agency
(FEPA); those are added per-state in the JSON where relevant.

| | Jurisdiction | Primary agency | Source (verify) |
| --- | --- | --- | --- |
| AL | Alabama | Dept of Labor | https://labor.alabama.gov |
| AK | Alaska | Dept of Labor & Workforce Development | https://labor.alaska.gov |
| AZ | Arizona | Industrial Commission of Arizona | https://www.azica.gov |
| AR | Arkansas | Dept of Labor & Licensing | https://www.labor.arkansas.gov |
| CA | California | Dept of Industrial Relations (DLSE) | https://www.dir.ca.gov |
| CO | Colorado | Dept of Labor & Employment (CDLE) | https://cdle.colorado.gov |
| CT | Connecticut | Dept of Labor | https://portal.ct.gov/dol |
| DE | Delaware | Dept of Labor | https://labor.delaware.gov |
| FL | Florida | Dept of Commerce (min wage; no state DOL) | https://www.floridajobs.org |
| GA | Georgia | Dept of Labor | https://dol.georgia.gov |
| HI | Hawaii | Dept of Labor & Industrial Relations | https://labor.hawaii.gov |
| ID | Idaho | Dept of Labor | https://www.labor.idaho.gov |
| IL | Illinois | Dept of Labor | https://labor.illinois.gov |
| IN | Indiana | Dept of Labor | https://www.in.gov/dol |
| IA | Iowa | Iowa Workforce Development / Div. of Labor | https://www.iowaworkforcedevelopment.gov |
| KS | Kansas | Dept of Labor | https://www.dol.ks.gov |
| KY | Kentucky | Education and Labor Cabinet | https://elc.ky.gov |
| LA | Louisiana | Workforce Commission | https://www.laworks.net |
| ME | Maine | Dept of Labor | https://www.maine.gov/labor |
| MD | Maryland | Dept of Labor | https://www.labor.maryland.gov |
| MA | Massachusetts | AG Fair Labor Division / EOLWD | https://www.mass.gov/orgs/office-of-the-attorney-general |
| MI | Michigan | Dept of Labor & Economic Opportunity | https://www.michigan.gov/leo |
| MN | Minnesota | Dept of Labor & Industry | https://www.dli.mn.gov |
| MS | Mississippi | Dept of Employment Security (no state DOL) | https://mdes.ms.gov |
| MO | Missouri | Dept of Labor & Industrial Relations | https://labor.mo.gov |
| MT | Montana | Dept of Labor & Industry | https://erd.dli.mt.gov |
| NE | Nebraska | Dept of Labor | https://dol.nebraska.gov |
| NV | Nevada | Office of the Labor Commissioner | https://labor.nv.gov |
| NH | New Hampshire | Dept of Labor | https://www.nh.gov/labor |
| NJ | New Jersey | Dept of Labor & Workforce Development | https://www.nj.gov/labor |
| NM | New Mexico | Dept of Workforce Solutions | https://www.dws.state.nm.us |
| NY | New York | Dept of Labor | https://dol.ny.gov |
| NC | North Carolina | Dept of Labor | https://www.labor.nc.gov |
| ND | North Dakota | Dept of Labor & Human Rights | https://www.nd.gov/labor |
| OH | Ohio | Dept of Commerce, Wage & Hour Bureau | https://com.ohio.gov |
| OK | Oklahoma | Dept of Labor | https://oklahoma.gov/odol |
| OR | Oregon | Bureau of Labor & Industries (BOLI) | https://www.oregon.gov/boli |
| PA | Pennsylvania | Dept of Labor & Industry | https://www.dli.pa.gov |
| RI | Rhode Island | Dept of Labor & Training | https://dlt.ri.gov |
| SC | South Carolina | Dept of Labor, Licensing & Regulation | https://llr.sc.gov |
| SD | South Dakota | Dept of Labor & Regulation | https://dlr.sd.gov |
| TN | Tennessee | Dept of Labor & Workforce Development | https://www.tn.gov/workforce |
| TX | Texas | Texas Workforce Commission | https://www.twc.texas.gov |
| UT | Utah | Labor Commission | https://laborcommission.utah.gov |
| VT | Vermont | Dept of Labor | https://labor.vermont.gov |
| VA | Virginia | Dept of Labor & Industry (DOLI) | https://www.doli.virginia.gov |
| WA | Washington | Dept of Labor & Industries (L&I) | https://www.lni.wa.gov |
| WV | West Virginia | Division of Labor | https://labor.wv.gov |
| WI | Wisconsin | Dept of Workforce Development | https://dwd.wisconsin.gov |
| WY | Wyoming | Dept of Workforce Services | https://dws.wyo.gov |

## State discrimination agencies (FEPAs) — added per state as authored

Examples: CA Civil Rights Dept (calcivilrights.ca.gov), NY Div. of Human Rights (dhr.ny.gov),
IL Dept of Human Rights (dhr.illinois.gov), WA Human Rights Commission (hum.wa.gov). Full list
compiled during Phase 2.

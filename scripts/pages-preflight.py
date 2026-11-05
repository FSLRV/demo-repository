"""Read Pages configuration inside the authorized deployment job."""
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

request = Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/pages',
                  headers={'Authorization':'Bearer ' + os.environ['PAGES_TOKEN'],
                           'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
try:
    with urlopen(request, timeout=30) as response:
        data=json.load(response)
        result={'httpStatus':200,'buildType':data.get('build_type'),'configured':True}
except HTTPError as error:
    result={'httpStatus':error.code,'configured':False}
with open(os.environ['GITHUB_OUTPUT'],'a') as output:
    output.write('report=' + json.dumps(result,separators=(',', ':')) + '\n')

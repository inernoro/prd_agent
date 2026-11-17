import copy
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('rollout',Path(__file__).parents[1]/'prd-agent-container-log-rollout.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class RolloutTests(unittest.TestCase):
    def test_preserves_secrets_images_volumes_and_network_for_replacement(self):
        before={'Image':'sha256:immutable','Config':{'Image':'latest','Env':['SECRET=value'],'Labels':{'service':'mongo'}},
          'HostConfig':{'LogConfig':{'Type':'json-file','Config':{}},'Binds':['data:/data/db'],
                        'PortBindings':{'80/tcp':[{'HostPort':'5500'}]},'ReadonlyRootfs':True},
          'Mounts':[{'Type':'volume','Name':'config-volume','Destination':'/data/configdb','RW':True}],
          'NetworkSettings':{'Networks':{'production':{'Aliases':['mongo'],'IPAddress':'172.20.0.3'}}}}
        original=copy.deepcopy(before);p=m.payload_for(before)
        self.assertEqual(before,original)
        self.assertEqual(p['Image'],'sha256:immutable')
        self.assertEqual(p['Env'],before['Config']['Env'])
        self.assertEqual(p['HostConfig']['Binds'],['data:/data/db','config-volume:/data/configdb'])
        self.assertEqual(p['HostConfig']['PortBindings'],before['HostConfig']['PortBindings'])
        self.assertTrue(p['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(p['HostConfig']['LogConfig'],m.LOG_CONFIG)
        self.assertEqual(p['NetworkingConfig']['EndpointsConfig']['production'],
          {'Aliases':['mongo'],'IPAMConfig':{'IPv4Address':'172.20.0.3'}})

if __name__=='__main__':unittest.main()
